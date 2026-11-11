import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import {
  BANKS,
  crossesRiver,
  RIVER,
  TRAM_DECK,
  tramHeight,
  inChannel,
  network,
  POD_Y,
  QUAY,
  RAIL_Y,
  spanSupports,
  type Network,
  type NetworkExtent,
  type Rank,
  type Stop,
} from '../../../shared/commute.js';
import { CONTACT_Y, filleted, miters, offsetLoop, POD_BEAM, RAIL_R, RAIL_TRACK, TRAM_R, TRAM_TRACK } from './lines.js';
import { LAYER, setLayers } from './lod.js';
import { materials } from './materials';

/**
 * The transit network as it stands in the city (Task 30): what
 * shared/commute.ts routes the commuters on, drawn as real urban transit at
 * dusk.
 *
 * - The tram: grooved rails on a raised sett reservation down the middle of
 *   the street, centre poles with twin cantilevers carrying a simple
 *   catenary (a contact wire over each track, a messenger above it and
 *   droppers between), stops with raised platforms and glazed shelters each
 *   side. Over the river the line runs without wires between anchor poles
 *   on the quays, as trams do across historic bridges.
 * - The elevated rail: a precast concrete trough on paired round piers and
 *   tapered crossheads, 26.7 m spans on the block rhythm, a steel Warren
 *   truss over the river, and stations at platform height with a canopy, a
 *   glazed windscreen, a ticket hall slung under the deck and a stair to the
 *   pavement.
 * - The pods: twin steel box guideways on slender Y pylons in the street's
 *   median at 18 m, a lit line along each beam, a bowstring over the river,
 *   glass stations lit from within with a lift to the street, and an
 *   interchange where the two lines cross.
 * - Cab ranks: three marked bays in the kerb lane with a lit sign.
 *
 * Everything is gathered by 480 m chunk, tier and material and merged, so
 * the frustum culls by chunk; the detail tier and the shadow and AO passes
 * keep near the eye, and past it every chunk draws from one far core per
 * material (as river.ts does). Wires are line segments: a pixel wide at any
 * distance, so the catenary still reads from afar, fading with distance.
 *
 * Every lateral "+" side below is the side of the street with no street
 * lamps (grid.ts lights the north side of streets along x and the west side
 * of streets along z): shelters, stairs and lifts stand there.
 */

type V2 = { x: number; z: number };
type V3 = [number, number, number];

/** Chunks: 480 m squares. */
const CHUNK = 480;
/** The detail tier draws within this of a chunk, shadows within SHADOW_NEAR, the AO within AO_NEAR (river-lod.ts numbers). */
const DETAIL_NEAR = 450;
const SHADOW_NEAR = 400;
const AO_NEAR = 320;
/** Wires draw within this; past it the catenary reads as the lit line of the stops and the reservation. */
const WIRE_FAR = 2400;

/** The tram's gauge (the track centres, the curve radii and the contact wire's height are in lines.ts). */
const GAUGE = 1.435;
/** The messenger wire over the contact wire at the poles. */
const MESSENGER_Y = 6.9;

// ---------------------------------------------------------------- geometry gathering

const Y = new THREE.Vector3(0, 1, 0);
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const CYLS = new Map<string, THREE.BufferGeometry>();
function cylinder(seg: number, top = 1): THREE.BufferGeometry {
  const key = `${seg}:${top}`;
  let g = CYLS.get(key);
  if (!g) CYLS.set(key, (g = new THREE.CylinderGeometry(top, 1, 1, seg, 1)));
  return g;
}

type Tier = 'core' | 'detail';

class Build {
  private by = new Map<string, Map<THREE.Material, THREE.BufferGeometry[]>>();
  private wires = new Map<string, number[]>();
  tier: Tier = 'core';
  detail(fn: () => void): void {
    const was = this.tier;
    this.tier = 'detail';
    fn();
    this.tier = was;
  }
  add(mat: THREE.Material, g: THREE.BufferGeometry, m?: THREE.Matrix4): void {
    let geo = g.index ? g.toNonIndexed() : g.clone();
    if (m) geo.applyMatrix4(m);
    for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    geo = geo.index ? geo.toNonIndexed() : geo;
    geo.computeBoundingBox();
    const bb = geo.boundingBox!;
    const key = `${chunkKey((bb.min.x + bb.max.x) / 2, (bb.min.z + bb.max.z) / 2)}|${this.tier}`;
    let mats = this.by.get(key);
    if (!mats) this.by.set(key, (mats = new Map()));
    const list = mats.get(mat) ?? [];
    list.push(geo);
    mats.set(mat, list);
  }
  box(mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0): void {
    this.add(mat, UNIT_BOX, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(Y, ry), new THREE.Vector3(sx, sy, sz)));
  }
  /** A box from a to b (its long axis), w by h in section; `up` fixes its roll. */
  beam(mat: THREE.Material, a: V3, b: V3, w: number, h: number, up: V3 = [0, 1, 0]): void {
    const A = new THREE.Vector3(...a);
    const B = new THREE.Vector3(...b);
    const len = A.distanceTo(B);
    if (len < 1e-4) return;
    const xAxis = B.clone().sub(A).normalize();
    let zAxis = new THREE.Vector3().crossVectors(xAxis, new THREE.Vector3(...up));
    if (zAxis.lengthSq() < 1e-6) zAxis = new THREE.Vector3().crossVectors(xAxis, new THREE.Vector3(1, 0, 0));
    zAxis.normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis);
    const m = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis).scale(new THREE.Vector3(len, h, w));
    m.setPosition(A.clone().add(B).multiplyScalar(0.5));
    this.add(mat, UNIT_BOX, m);
  }
  rod(mat: THREE.Material, a: V3, b: V3, r: number, seg = 6, taper = 1): void {
    const A = new THREE.Vector3(...a);
    const B = new THREE.Vector3(...b);
    const len = A.distanceTo(B);
    if (len < 1e-4) return;
    const q = new THREE.Quaternion().setFromUnitVectors(Y, B.clone().sub(A).normalize());
    this.add(mat, cylinder(seg, taper), new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), q, new THREE.Vector3(r, len, r)));
  }
  put(mat: THREE.Material, g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0, s: V3 = [1, 1, 1]): void {
    this.add(mat, g, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(Y, ry), new THREE.Vector3(...s)));
  }
  /**
   * A profile swept straight from a to b: the profile is [lateral, height]
   * pairs (lateral to the left of the run, seen from above looking from a to
   * b), closed, with both ends capped when asked.
   */
  sweep(mat: THREE.Material, profile: Array<[number, number]>, a: V2, b: V2, y0: number, caps = false, uvScale = 0): void {
    const t = new THREE.Vector2(b.x - a.x, b.z - a.z);
    const len = t.length();
    if (len < 1e-4) return;
    // Faces point outward when the profile runs counter-clockwise (lateral right, height up).
    let area = 0;
    for (let i = 0; i < profile.length; i++) {
      const [l0, h0] = profile[i];
      const [l1, h1] = profile[(i + 1) % profile.length];
      area += l0 * h1 - l1 * h0;
    }
    if (area < 0) profile = [...profile].reverse();
    t.divideScalar(len);
    const n = { x: -t.y, z: t.x };
    const at = (p: V2, [l, h]: [number, number]): V3 => [p.x + n.x * l, y0 + h, p.z + n.z * l];
    const pos: number[] = [];
    const uv: number[] = [];
    const P = profile.length;
    let run = 0;
    for (let i = 0; i < P; i++) {
      const p = profile[i];
      const q = profile[(i + 1) % P];
      const seg = Math.hypot(q[0] - p[0], q[1] - p[1]);
      const a0 = at(a, p);
      const a1 = at(a, q);
      const b0 = at(b, p);
      const b1 = at(b, q);
      pos.push(...a0, ...b0, ...b1, ...a0, ...b1, ...a1);
      const u0 = run * uvScale;
      const u1 = (run + seg) * uvScale;
      const v1 = len * uvScale;
      uv.push(u0, 0, u0, v1, u1, v1, u0, 0, u1, v1, u1, 0);
      run += seg;
    }
    if (caps) {
      const tri = THREE.ShapeUtils.triangulateShape(
        profile.map(([l, h]) => new THREE.Vector2(l, h)),
        [],
      );
      for (const [i0, j0, k0] of tri) {
        // Each cap faces out of its end: counter-clockwise in the profile's plane faces back along the run.
        const [pi, pj, pk] = [profile[i0], profile[j0], profile[k0]];
        const ccw = (pj[0] - pi[0]) * (pk[1] - pi[1]) - (pj[1] - pi[1]) * (pk[0] - pi[0]) > 0;
        const [i, j, k] = ccw ? [i0, j0, k0] : [i0, k0, j0];
        pos.push(...at(a, profile[i]), ...at(a, profile[j]), ...at(a, profile[k]));
        pos.push(...at(b, profile[i]), ...at(b, profile[k]), ...at(b, profile[j]));
        for (let r = 0; r < 6; r++) uv.push(0, 0);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    this.add(mat, g);
    g.dispose();
  }
  /** A flat strip w wide along the polyline at height y, its UVs in world metres scaled by `uv`. */
  strip(mat: THREE.Material, pts: V2[], w: number, yAt: number | ((p: V2) => number), uvScale = 1): void {
    const yOf = (p: V2): number => (typeof yAt === 'number' ? yAt : yAt(p));
    const pos: number[] = [];
    const uv: number[] = [];
    const normals = miters(pts, false);
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const na = normals[i - 1];
      const nb = normals[i];
      const L = (p: V2, n: V2, s: number): V3 => [p.x + n.x * s, yOf(p), p.z + n.z * s];
      const a0 = L(a, na, -w / 2);
      const a1 = L(a, na, w / 2);
      const b0 = L(b, nb, -w / 2);
      const b1 = L(b, nb, w / 2);
      pos.push(...a0, ...b1, ...b0, ...a0, ...a1, ...b1);
      for (const p of [a0, b1, b0, a0, a1, b1]) uv.push(p[0] * uvScale, p[2] * uvScale);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.computeVertexNormals();
    this.add(mat, g);
    g.dispose();
  }
  /**
   * A slab from a to b, `half` either side of the run, its top and bottom
   * heights given at each end (a ramp or a deck), sides and ends closed.
   */
  prism(mat: THREE.Material, a: V2, b: V2, half: number, topA: number, topB: number, botA: number, botB: number): void {
    const t = norm({ x: b.x - a.x, z: b.z - a.z });
    if (!t) return;
    const n = { x: -t.z, z: t.x };
    const P = (p: V2, l: number, y: number): V3 => [p.x + n.x * l, y, p.z + n.z * l];
    const quad = (q0: V3, q1: V3, q2: V3, q3: V3): number[] => [...q0, ...q1, ...q2, ...q0, ...q2, ...q3];
    const pos = [
      ...quad(P(a, -half, botA), P(b, -half, botB), P(b, -half, topB), P(a, -half, topA)),
      ...quad(P(a, half, botA), P(a, half, topA), P(b, half, topB), P(b, half, botB)),
      ...quad(P(a, -half, topA), P(b, -half, topB), P(b, half, topB), P(a, half, topA)),
      ...quad(P(a, -half, botA), P(a, half, botA), P(b, half, botB), P(b, -half, botB)),
    ];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    this.add(mat, g);
    g.dispose();
  }
  /** A wire: line segments through the points, gathered by chunk. */
  wire(pts: V3[]): void {
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const key = chunkKey((a[0] + b[0]) / 2, (a[2] + b[2]) / 2);
      const list = this.wires.get(key) ?? [];
      list.push(...a, ...b);
      this.wires.set(key, list);
    }
  }
  finish(shadows: (m: THREE.Material) => boolean, wireMat: THREE.LineBasicMaterial): TransitChunk[] {
    const out = new Map<string, TransitChunk>();
    const chunkOf = (key: string): TransitChunk => {
      let c = out.get(key);
      if (!c) {
        const [cx, cz] = key.split(',').map(Number);
        const group = new THREE.Group();
        group.name = `transit-chunk-${key}`;
        const core = new THREE.Group();
        const detail = new THREE.Group();
        group.add(core, detail);
        out.set(key, (c = { key, cx, cz, group, core, detail, wires: null, casters: [], coreGeos: new Map(), lod: null, triangles: 0 }));
      }
      return c;
    };
    for (const [k, mats] of this.by) {
      const [key, tier] = k.split('|') as [string, Tier];
      const c = chunkOf(key);
      for (const [mat, list] of mats) {
        const geo = mergeGeometries(list, false);
        for (const g of list) g.dispose();
        if (!geo) continue;
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = shadows(mat);
        mesh.receiveShadow = true;
        if (mesh.castShadow) c.casters.push(mesh);
        mesh.name = `transit:${mat.name || mat.type}`;
        (tier === 'core' ? c.core : c.detail).add(mesh);
        if (tier === 'core') c.coreGeos.set(mat, geo);
        c.triangles += geo.attributes.position.count / 3;
      }
    }
    for (const [key, list] of this.wires) {
      const c = chunkOf(key);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
      g.computeBoundingSphere();
      const lines = new THREE.LineSegments(g, wireMat);
      lines.name = 'transit:wires';
      c.wires = lines;
      c.group.add(lines);
    }
    this.by.clear();
    this.wires.clear();
    return [...out.values()].sort((a, b) => a.cz - b.cz || a.cx - b.cx);
  }
}

function chunkKey(x: number, z: number): string {
  return `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
}

interface TransitChunk {
  key: string;
  cx: number;
  cz: number;
  group: THREE.Group;
  core: THREE.Group;
  detail: THREE.Group;
  wires: THREE.LineSegments | null;
  casters: THREE.Mesh[];
  coreGeos: Map<THREE.Material, THREE.BufferGeometry>;
  lod: { detail: boolean; shadow: boolean; ao: boolean } | null;
  triangles: number;
}

/** From the eye to the nearest point of a chunk's square (its full height taken as 0 to 40 m). */
function chunkDistance(eye: THREE.Vector3, c: TransitChunk): number {
  const x0 = c.cx * CHUNK;
  const z0 = c.cz * CHUNK;
  const dx = Math.max(x0 - eye.x, 0, eye.x - (x0 + CHUNK));
  const dz = Math.max(z0 - eye.z, 0, eye.z - (z0 + CHUNK));
  const dy = Math.max(0 - eye.y, 0, eye.y - 40);
  return Math.hypot(dx, dy, dz);
}

// ---------------------------------------------------------------- paths

function norm(v: V2): V2 | null {
  const l = Math.hypot(v.x, v.z);
  return l < 1e-9 ? null : { x: v.x / l, z: v.z / l };
}

/** Splits a closed polyline into runs at the points where keep() turns false (bridges with no wires, for one). */
function closedRuns(pts: V2[], keep: (a: V2, b: V2) => boolean): V2[][] {
  const runs: V2[][] = [];
  let cur: V2[] = [];
  for (let i = 0; i <= pts.length; i++) {
    const a = pts[i % pts.length];
    const b = pts[(i + 1) % pts.length];
    if (i < pts.length && keep(a, b)) {
      if (!cur.length) cur.push(a);
      cur.push(b);
    } else if (cur.length) {
      runs.push(cur);
      cur = [];
    }
  }
  return runs;
}

/** Straight runs of an axis-aligned closed loop: corner to corner. */
function sides(corners: V2[]): Array<{ a: V2; b: V2 }> {
  return corners.map((a, i) => ({ a, b: corners[(i + 1) % corners.length] }));
}

/** The point at u along an axis-aligned run, and the run's along and left unit vectors. */
function frameOf(a: V2, b: V2): { t: V2; n: V2; at(u: number, l?: number): V2; dir: 'x' | 'z' } {
  const dir = a.z === b.z ? 'x' : 'z';
  const t = norm({ x: b.x - a.x, z: b.z - a.z })!;
  const n = { x: -t.z, z: t.x };
  return {
    t,
    n,
    dir,
    at: (u, l = 0) => (dir === 'x' ? { x: u + n.x * l, z: a.z + n.z * l } : { x: a.x + n.x * l, z: u + n.z * l }),
  };
}


// ---------------------------------------------------------------- materials

interface TransitMaterials {
  concrete: THREE.MeshStandardMaterial;
  deckTop: THREE.MeshStandardMaterial;
  railSteel: THREE.MeshStandardMaterial;
  frame: THREE.MeshStandardMaterial;
  truss: THREE.MeshStandardMaterial;
  podSteel: THREE.MeshStandardMaterial;
  roof: THREE.MeshStandardMaterial;
  setts: THREE.MeshStandardMaterial;
  paint: THREE.MeshStandardMaterial;
  timber: THREE.MeshStandardMaterial;
  glassWarm: THREE.MeshStandardMaterial;
  paving: THREE.MeshStandardMaterial;
  tactile: THREE.MeshStandardMaterial;
  glassCool: THREE.MeshStandardMaterial;
  glassClear: THREE.MeshStandardMaterial;
  podFloor: THREE.MeshStandardMaterial;
  ceiling: THREE.MeshStandardMaterial;
  lampWarm: THREE.MeshBasicMaterial;
  lampCool: THREE.MeshBasicMaterial;
  red: THREE.MeshBasicMaterial;
  sign: THREE.MeshBasicMaterial;
}

/**
 * Board-marked concrete: lifts of formwork every 1.2 m, a tone per pour, and
 * run-off stains under every edge; underneath, the warm bounce of the street
 * lamps.
 */
function concreteMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xa8a49c, roughness: 0.9, metalness: 0 });
  m.name = 'concrete';
  m.customProgramCacheKey = () => 'palimpsest-transit-concrete';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTP; varying vec3 vTN;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTP; varying vec3 vTN;
        float tHash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
        float tNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(tHash(i), tHash(i+vec2(1,0)), f.x), mix(tHash(i+vec2(0,1)), tHash(i+vec2(1,1)), f.x), f.y); }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec3 n = abs(vTN);
          vec2 q = n.x > n.z ? vTP.zy : vTP.xy;
          if (n.y > 0.7) q = vTP.xz;
          float pour = tHash(floor(vec2(q.x / 26.6, vTP.y / 3.6)));
          float lift = n.y > 0.7 ? 1.0 : 1.0 - 0.07 * (1.0 - smoothstep(0.0, 0.035, abs(fract(vTP.y / 1.2) - 0.5) * 2.0 - 0.94));
          float board = n.y > 0.7 ? 1.0 : 0.96 + 0.06 * tNoise(vec2(q.x * 6.0, vTP.y * 0.6));
          // Run-off: streaks hang down from each pour's top edge, darker toward it.
          float streak = (1.0 - n.y) * tNoise(vec2(q.x * 1.7, 0.0)) * smoothstep(0.0, 2.5, fract(vTP.y / 3.6) * 3.6) * 0.0;
          float stain = tNoise(q * 0.35) * 0.5 + tNoise(q * 1.9) * 0.25;
          diffuseColor.rgb *= (0.86 + 0.12 * pour) * lift * board * (0.88 + 0.2 * stain) - streak;
          // Precast segments meet over every bent (the 80/3 m rhythm): a dark joint up the deck's faces.
          if (vTP.y > 8.5 && n.y < 0.7) {
            float u = n.x > n.z ? vTP.z : vTP.x;
            float j = abs(fract(u / 26.6667 + 0.5) - 0.5) * 26.6667;
            diffuseColor.rgb *= mix(0.35, 1.0, smoothstep(0.02, 0.05, j));
          }
          // The deck's soffit and the crossheads take a weather line: darker toward the drip edge.
          diffuseColor.rgb *= 1.0 - 0.12 * smoothstep(0.6, 1.0, n.y < -0.5 ? 1.0 : 0.0);
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.72, 0.45) * (max(-vTN.y, 0.0) * 0.05 + (1.0 - abs(vTN.y)) * 0.05 * exp(-max(vTP.y, 0.0) / 5.0));`,
      );
  };
  return m;
}

/**
 * Glass over a lit interior: mullions every 1.5 m and a transom, a cool
 * reflection of the sky at a glancing view and the room's light straight on.
 */
function litGlass(name: string, tint: THREE.Color, strength: number): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x0c0f12, roughness: 0.06, metalness: 0.0, envMapIntensity: 1.6 });
  m.name = name;
  m.customProgramCacheKey = () => `palimpsest-transit-${name}`;
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGP; varying vec3 vGN;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvGN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGP; varying vec3 vGN;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          vec3 V = normalize(cameraPosition - vGP);
          float facing = abs(dot(V, normalize(vGN)));
          float along = abs(vGN.x) > abs(vGN.z) ? vGP.z : vGP.x;
          if (abs(vGN.y) > 0.7) along = vGP.x + vGP.z;
          // 1 in the pane, 0 on a 6 cm mullion every 1.5 m and a transom every 3 m.
          float mull = 1.0 - smoothstep(0.475, 0.49, abs(fract(along / 1.5) - 0.5));
          float tr = 1.0 - smoothstep(0.484, 0.494, abs(fract((vGP.y - 0.4) / 3.0) - 0.5));
          // Lit from the ceiling: the top of each storey brightest, the floor's depth darker, seen straight on.
          float storey = fract((vGP.y - 0.4) / 3.0);
          float room = 0.22 + 0.4 * smoothstep(0.35, 0.92, storey) + 0.5 * smoothstep(0.9, 0.97, storey) * (1.0 - smoothstep(0.97, 0.985, storey));
          float lit = (0.2 + 0.8 * pow(facing, 0.6)) * mull * tr * room;
          // A luminaire in each bay just under the ceiling, and the room's floor edge dark.
          float sh = storey * 3.0;
          float bu = fract(along / 1.5);
          float lum = (1.0 - smoothstep(0.2, 0.26, abs(bu - 0.5))) * smoothstep(2.48, 2.52, sh) * (1.0 - smoothstep(2.62, 2.66, sh));
          lit = lit * (1.0 - 0.7 * (1.0 - smoothstep(0.15, 0.3, sh))) + lum * 4.5 * pow(facing, 0.4) * mull;
          // A little variety: some bays brighter (a lamp nearer the glass), a few dimmer.
          float bay = 0.8 + 0.4 * fract(sin(floor(along / 1.5) * 12.9898) * 43758.5453);
          totalEmissiveRadiance += vec3(${tint.r.toFixed(3)}, ${tint.g.toFixed(3)}, ${tint.b.toFixed(3)}) * ${strength.toFixed(3)} * lit * bay;
          diffuseColor.rgb = mix(vec3(0.05), diffuseColor.rgb, mull * tr);
        }`,
      );
  };
  return m;
}

/**
 * The pods' white steel: a warm off-white painted finish whose faces read
 * apart (tops catch the sky, undersides fall into shade) with fine panel
 * joints every 1.5 m on the upright faces.
 */
function shadedSteel(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xd2cec5, metalness: 0.2, roughness: 0.42 });
  m.name = 'podSteel';
  m.customProgramCacheKey = () => 'palimpsest-transit-pod-steel';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSP; varying vec3 vSN;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvSP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvSN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vSP; varying vec3 vSN;').replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        float up = vSN.y;
        diffuseColor.rgb *= mix(0.62, 1.0, smoothstep(-0.9, 0.6, up));
        if (abs(up) < 0.5) {
          float along = abs(vSN.x) > abs(vSN.z) ? vSP.z : vSP.x;
          float j = abs(fract(along / 1.5 + 0.5) - 0.5) * 1.5;
          diffuseColor.rgb *= mix(0.78, 1.0, smoothstep(0.008, 0.02, j));
          // Weathering: faintly darker toward the foot of each upright face.
          diffuseColor.rgb *= 0.92 + 0.08 * smoothstep(0.0, 6.0, fract(vSP.y / 6.0) * 6.0);
        }
      }`,
    );
  };
  return m;
}

/** Concrete paving slabs, 600 mm square on a running bond, each its own tone, with sunk joints and a little grit. */
function pavingMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x9a948a, roughness: 0.82, metalness: 0 });
  m.name = 'paving';
  m.customProgramCacheKey = () => 'palimpsest-transit-paving';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vPP;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvPP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vPP;\nfloat pvHash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }').replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        vec2 q = vPP.xz / 0.6;
        q.x += 0.5 * mod(floor(q.y), 2.0);
        vec2 f = fract(q);
        vec2 cell = floor(q);
        float joint = 1.0 - smoothstep(0.012, 0.03, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
        float tone = 0.86 + 0.24 * pvHash(cell);
        float grit = 0.94 + 0.12 * pvHash(floor(vPP.xz * 60.0));
        diffuseColor.rgb *= tone * grit * mix(1.0, 0.45, joint);
      }`,
    );
  };
  return m;
}

/** A tactile edge strip: safety yellow, its blisters standing in rows, catching the light. */
function tactileMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xc8a020, roughness: 0.55, metalness: 0 });
  m.name = 'tactile';
  m.customProgramCacheKey = () => 'palimpsest-transit-tactile';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vTPp;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTPp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vTPp;').replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        vec2 f = fract(vTPp.xz / 0.066) - 0.5;
        float blister = 1.0 - smoothstep(0.2, 0.32, length(f));
        diffuseColor.rgb *= mix(0.72, 1.12, blister);
      }`,
    );
  };
  return m;
}

/** Steel washed from below by floodlights on the bents: brightest at the deck, fading up the truss. */
function upwashed(m: THREE.MeshStandardMaterial, key: string, base: number, reach: number, strength: number): THREE.MeshStandardMaterial {
  m.name = key;
  m.customProgramCacheKey = () => `palimpsest-transit-uplit-${key}`;
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vUP; varying vec3 vUN;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvUP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvUN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vUP; varying vec3 vUN;').replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        float h = max(vUP.y - ${base.toFixed(2)}, 0.0);
        float wash = (1.0 - abs(vUN.y)) * exp(-h / ${reach.toFixed(2)}) + max(-vUN.y, 0.0) * 0.5;
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.8, 0.6) * wash * ${strength.toFixed(3)};
      }`,
    );
  };
  return m;
}

/** Granite setts laid in rows across the reservation, the tram's raised track bed. */
function settsTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const t = new THREE.CanvasTexture(c);
  if (!g) return t;
  g.fillStyle = '#2b2a28';
  g.fillRect(0, 0, 256, 256);
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const rows = 16;
  for (let r = 0; r < rows; r++) {
    const h = 256 / rows;
    let x = r % 2 ? -10 : 0;
    while (x < 256) {
      const w = 14 + rnd() * 9;
      const v = 88 + rnd() * 46;
      g.fillStyle = `rgb(${v * 0.98},${v * 0.96},${v * 0.93})`;
      g.fillRect(x + 1.2, r * h + 1.2, w - 2.4, h - 2.4);
      x += w;
    }
  }
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// ---------------------------------------------------------------- signs

/** Where each name comes from: a stable hash of the place, so a stop keeps its name as the network grows. */
const TRAM_NAMES = ['Coopers Row', 'Tallow Lane', 'Saddlers Gate', 'Wick Street', 'Bellfounders', 'Limekiln Road', 'Hatters Cross', 'Furnace Yard', 'Glovers Walk', 'Rope Street', 'Malt House', 'Tanners Bank', 'Weavers Hill', 'Cordwainers', 'Slate Street', 'Kiln Lane', 'Pewter Row', 'Chandlery', 'Ink Street', 'Barrow Lane', 'Tinsmiths', 'Wharf Road', 'Paper Mill', 'Hop Garden'];
const RAIL_NAMES = ['Gantry Street', 'Signal Hill', 'Foundry Road', 'Northgate', 'Mercer Street', 'Old Exchange', 'Lantern Street', 'Quarry Lane', 'Viaduct Row', 'Long Acre', 'Smithfield', 'Crane Street', 'Iron Bridge', 'Southgate', 'Copperfield', 'Westgate'];
const POD_NAMES = ['Ledger Square', 'Assay', 'Treasury', 'Exchange', 'Guild Hall', 'Kumo', 'Fieldnotes', 'Datum', 'Quarry Point', 'Harbor', 'Palimpsest', 'Lens', 'Cantilever', 'Needle', 'Vane'];

function nameAt(list: readonly string[], x: number, z: number, taken: Set<string>): string {
  const h = (Math.imul(Math.round(x), 73856093) ^ Math.imul(Math.round(z), 19349663)) >>> 0;
  for (let k = 0; k < list.length; k++) {
    const name = list[(h + k) % list.length];
    if (!taken.has(name)) {
      taken.add(name);
      return name;
    }
  }
  return list[h % list.length];
}

type SignStyle = 'tram' | 'rail' | 'pod' | 'cab';
const SIGN_W = 1024;
const SIGN_H = 96;
const SIGN_COLS = 2;
const SIGN_ROWS = 40;
/** The signs' brightness: the plates are drawn dim and the lettering near white, so lifted, only the letters bloom. */
const SIGN_LIFT = 1.45;
/** A sign's height for its width: one atlas row. */
const SIGN_ASPECT = SIGN_H / SIGN_W;

/** One canvas for every sign in the network: each row a name in its mode's livery. */
class SignAtlas {
  canvas = document.createElement('canvas');
  texture: THREE.CanvasTexture;
  private rows: Array<{ text: string; small: string; style: SignStyle }> = [];
  constructor() {
    this.canvas.width = SIGN_W * SIGN_COLS;
    this.canvas.height = SIGN_H * SIGN_ROWS;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 8;
  }
  /** The UV rectangle [u0, v0, u1, v1] of a new sign. */
  add(text: string, small: string, style: SignStyle): [number, number, number, number] {
    const i = this.rows.length % (SIGN_COLS * SIGN_ROWS);
    this.rows.push({ text, small, style });
    const col = i % SIGN_COLS;
    const row = Math.floor(i / SIGN_COLS);
    const u0 = col / SIGN_COLS;
    const v1 = 1 - row / SIGN_ROWS;
    return [u0 + 0.002, v1 - 1 / SIGN_ROWS + 0.004, u0 + 1 / SIGN_COLS - 0.002, v1 - 0.004];
  }
  /**
   * Every sign in the app's own faces (style.css: Newsreader for the name,
   * IBM Plex Mono capitals for the line it serves, both at weights the app
   * ships), on an enamel plate with an inset frame: a dark border, a hairline
   * rule inside it in the livery's metal. The plate is drawn dim and the
   * lettering bright, and the sign material lifts the whole (SIGN_LIFT), so
   * at dusk the letters read as lit from behind and only they bloom.
   */
  draw(): void {
    const g = this.canvas.getContext('2d');
    if (!g) return;
    const livery: Record<SignStyle, { plate: string; edge: string; rule: string; ink: string; label: string }> = {
      tram: { plate: '#14291f', edge: '#0a1510', rule: '#a8976a', ink: '#f4ead2', label: '#cbbd94' },
      rail: { plate: '#341412', edge: '#1a0908', rule: '#b39a6c', ink: '#f6ecd6', label: '#d6bf96' },
      pod: { plate: '#1b2226', edge: '#0c1013', rule: '#3d93b4', ink: '#eef3f4', label: '#8fc6d8' },
      cab: { plate: '#3a2a10', edge: '#1a1206', rule: '#d9a441', ink: '#ffd88a', label: '#d9a441' },
    };
    const name = (px: number): string => `500 ${px}px Newsreader, "Iowan Old Style", Georgia, serif`;
    const mono = (px: number): string => `400 ${px}px "IBM Plex Mono", ui-monospace, Menlo, monospace`;
    const spaced = (t: string): string => t.toUpperCase().split('').join('\u2009');
    this.rows.forEach((r, i) => {
      const x = (i % SIGN_COLS) * SIGN_W;
      const y = Math.floor(i / SIGN_COLS) * SIGN_H;
      const l = livery[r.style];
      // The plate, its dark border, and the inset hairline frame.
      g.fillStyle = l.edge;
      g.fillRect(x, y, SIGN_W, SIGN_H);
      g.fillStyle = l.plate;
      g.fillRect(x + 7, y + 7, SIGN_W - 14, SIGN_H - 14);
      g.strokeStyle = l.rule;
      g.lineWidth = 2;
      g.strokeRect(x + 14, y + 14, SIGN_W - 28, SIGN_H - 28);
      g.textBaseline = 'middle';
      if (r.style === 'cab') {
        // A cab sign is read through its middle third (cabRank): the word large and centred, lit amber.
        g.fillStyle = l.ink;
        g.font = name(60);
        g.textAlign = 'center';
        g.fillText(r.text, x + SIGN_W / 2, y + SIGN_H / 2 + 2);
        g.textAlign = 'left';
        return;
      }
      if (r.style === 'pod') {
        // The pods' mark: a short upright bar in the line's blue before the name.
        g.fillStyle = l.rule;
        g.fillRect(x + 34, y + 26, 6, SIGN_H - 52);
      }
      g.fillStyle = l.ink;
      g.font = name(52);
      g.textAlign = 'left';
      g.fillText(r.text, x + (r.style === 'pod' ? 60 : 42), y + SIGN_H / 2 + 3);
      g.fillStyle = l.label;
      g.font = mono(24);
      g.textAlign = 'right';
      g.fillText(spaced(r.small), x + SIGN_W - 42, y + SIGN_H / 2 + 2);
    });
    this.texture.needsUpdate = true;
  }
}

/** A sign panel w by h facing along `face` (a unit vector in the ground plane), centred at p, reading the atlas rectangle. */
function signPanel(b: Build, mat: THREE.Material, p: V3, face: V2, w: number, h: number, uv: [number, number, number, number]): void {
  const g = new THREE.PlaneGeometry(w, h);
  const a = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < a.count; i++) a.setXY(i, a.getX(i) ? uv[2] : uv[0], a.getY(i) ? uv[3] : uv[1]);
  const ry = Math.atan2(face.x, face.z);
  b.put(mat, g, p[0], p[1], p[2], ry);
  g.dispose();
}

// ---------------------------------------------------------------- the tram

/** A closed polyline with every piece longer than `max` cut, and on its straight runs a point at each multiple of `step`. */
function subdivide(pts: V2[], max: number, step = 0): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const c = pts[(i + 1) % pts.length];
    out.push(a);
    const len = Math.hypot(c.x - a.x, c.z - a.z);
    const alongX = Math.abs(c.z - a.z) < 1e-6;
    const alongZ = Math.abs(c.x - a.x) < 1e-6;
    const cuts: number[] = [];
    if (step && (alongX || alongZ) && len > step) {
      // On a straight run, cut at the rhythm itself so the wires meet every pole at a sample.
      const u0 = alongX ? a.x : a.z;
      const u1 = alongX ? c.x : c.z;
      for (let u = Math.ceil(Math.min(u0, u1) / step) * step; u < Math.max(u0, u1); u += step) {
        if (Math.abs(u - u0) > 0.5 && Math.abs(u - u1) > 0.5) cuts.push((u - u0) / (u1 - u0));
      }
    } else if (len > max) {
      const n = Math.ceil(len / max);
      for (let k = 1; k < n; k++) cuts.push(k / n);
    }
    cuts.sort((p, q) => p - q);
    for (const t of cuts) out.push({ x: a.x + (c.x - a.x) * t, z: a.z + (c.z - a.z) * t });
  }
  return out;
}

/** A closed polyline with every piece near where `near` holds cut to at most `max` metres. */
function refineNear(pts: V2[], near: (p: V2) => boolean, max: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const c = pts[(i + 1) % pts.length];
    out.push(a);
    const len = Math.hypot(c.x - a.x, c.z - a.z);
    if (!(near(a) || near(c) || near({ x: (a.x + c.x) / 2, z: (a.z + c.z) / 2 }))) {
      // A long piece may pass the river without either end near it: cut it where it does.
      if (len > max && Math.abs(c.z - a.z) < 1e-6 && (a.x - RIVER.x) * (c.x - RIVER.x) < 0) {
        const n = Math.ceil(len / max);
        for (let k = 1; k < n; k++) out.push({ x: a.x + ((c.x - a.x) * k) / n, z: a.z });
      }
      continue;
    }
    const n = Math.ceil(len / max);
    for (let k = 1; k < n; k++) out.push({ x: a.x + ((c.x - a.x) * k) / n, z: a.z + ((c.z - a.z) * k) / n });
  }
  return out;
}

/**
 * The tram's own bridge where its street crosses the river: two riveted
 * plate girders with stiffeners from quay wall to quay wall under the deck,
 * bearing on the walls' copings, cross girders between them, and a railing
 * with posts along each edge of the deck and down the ramps over the quays.
 */
function tramBridge(b: Build, M: TransitMaterials, z: number): void {
  const x0 = BANKS.west - 1.2;
  const x1 = BANKS.east + 1.2;
  const top = TRAM_DECK.height - 0.45;
  for (const s of [-1, 1]) {
    const gz = z + s * 3.5;
    b.beam(M.truss, [x0, top - 0.9, gz], [x1, top - 0.9, gz], 0.5, 1.8);
    // Flanges proud of the web.
    for (const y of [top - 0.02, top - 1.78]) b.beam(M.truss, [x0, y, gz], [x1, y, gz], 0.7, 0.08);
    b.detail(() => {
      for (let x = x0 + 2; x < x1 - 1; x += 2.2) b.beam(M.truss, [x, top - 1.75, gz + s * 0.27], [x, top - 0.05, gz + s * 0.27], 0.12, 0.06);
    });
    // Bearings on the copings.
    for (const x of [x0 + 0.6, x1 - 0.6]) b.box(M.frame, x, top - 1.95, gz, 0.8, 0.3, 0.9);
  }
  for (let x = x0 + 4; x < x1 - 2; x += 6.5) b.beam(M.truss, [x, top - 0.7, z - 3.5], [x, top - 0.7, z + 3.5], 0.3, 1.0);
  // The railing: a top rail, a mid rail and posts, over the river and down both ramps.
  const rx0 = BANKS.west - TRAM_DECK.ramp;
  const rx1 = BANKS.east + TRAM_DECK.ramp;
  for (const s of [-1, 1]) {
    const rz = z + s * 3.95;
    const pts: V3[] = [];
    for (let x = rx0; x <= rx1 + 0.01; x += 1.0) pts.push([x, tramHeight(x, z) + 0.075, rz]);
    for (let i = 1; i < pts.length; i++) {
      const [a, c] = [pts[i - 1], pts[i]];
      b.beam(M.frame, [a[0], a[1] + 1.05, a[2]], [c[0], c[1] + 1.05, c[2]], 0.07, 0.06);
      b.detail(() => b.beam(M.frame, [a[0], a[1] + 0.55, a[2]], [c[0], c[1] + 0.55, c[2]], 0.03, 0.03));
      if (i % 2 === 0) b.detail(() => b.beam(M.frame, [a[0], a[1], a[2]], [a[0], a[1] + 1.05, a[2]], 0.05, 0.05));
    }
  }
}

/** The pole rhythm: a pole every 80/3 m along a straight run. */
const POLE_STEP = 80 / 3;

function buildTram(b: Build, M: TransitMaterials, net: Network, signs: SignAtlas, names: Set<string>): { poles: number; stops: number } {
  const corners = net.tram.path.map(([x, , z]) => ({ x, z }));
  // Fine pieces where the tram climbs over the quays to its bridge, 40 m pieces elsewhere.
  const centre = refineNear(subdivide(filleted(corners, TRAM_R), 40), (p) => Math.abs(p.x - RIVER.x) < RIVER.width / 2 + TRAM_DECK.ramp + 6, 2);
  const lift = (p: V2): number => tramHeight(p.x, p.z);
  // The reservation: a raised sett bed under both tracks, edged in granite 8 cm proud of the asphalt; over the
  // river it is the bridge's deck slab, and over the quays a solid ramp down to the street.
  for (let i = 0; i < centre.length; i++) {
    const a = centre[i];
    const c = centre[(i + 1) % centre.length];
    const water = (p: V2): boolean => inChannel(p.x, -TRAM_DECK.flat);
    const top = (p: V2): number => lift(p) + 0.075;
    const bot = (p: V2): number => (water(p) ? top(p) - 0.5 : -0.05);
    // Over the river and up the ramps the deck widens past the trams' sweep to carry its railings.
    const half = lift(a) > 0 || lift(c) > 0 ? 4.1 : 3.05;
    b.prism(M.concrete, a, c, half, top(a), top(c), bot(a), bot(c));
    b.strip(M.setts, [a, c], 5.9, (p) => lift(p) + 0.087, 1 / 4.2);
  }
  // The tram's own bridges: plate girders from quay wall to quay wall under the deck, railings along both edges.
  for (const sd of sides(corners)) {
    if (!crossesRiver(sd.a, sd.b)) continue;
    tramBridge(b, M, sd.a.z);
  }
  // The rails, grooved in the bed: two per track, their heads 7 cm wide and polished.
  b.detail(() => {
    for (const side of [-1, 1]) {
      for (const g of [-GAUGE / 2, GAUGE / 2]) {
        const line = offsetLoop(centre, side * TRAM_TRACK + g);
        for (let i = 0; i < line.length; i++) {
          const p = line[i];
          const q = line[(i + 1) % line.length];
          b.beam(M.railSteel, [p.x, 0.092 + lift(p), p.z], [q.x, 0.092 + lift(q), q.z], 0.07, 0.012);
          b.beam(M.deckTop, [p.x, 0.089 + lift(p), p.z], [q.x, 0.089 + lift(q), q.z], 0.16, 0.006);
        }
      }
    }
  });

  // Poles: centre poles with twin cantilevers on every straight run, on the rhythm; none on a bridge's deck.
  let poles = 0;
  for (const sd of sides(corners)) {
    const f = frameOf(sd.a, sd.b);
    const u0 = f.dir === 'x' ? sd.a.x : sd.a.z;
    const u1 = f.dir === 'x' ? sd.b.x : sd.b.z;
    // On the tram's own bridge the poles stand on the deck at the same rhythm.
    const us = [...spanSupports(sd.a, sd.b)];
    if (crossesRiver(sd.a, sd.b)) for (const u of [RIVER.x - 80 / 6, RIVER.x + 80 / 6]) us.push(u);
    for (const u of us) {
      if (Math.abs(u - u0) < TRAM_R + 4 || Math.abs(u - u1) < TRAM_R + 4) continue;
      const p = f.at(u);
      centrePole(b, M, p, f.t, f.n, lift(p));
      poles++;
    }
  }
  // Corner poles: one outside each curve, its pull-offs holding the wires round.
  for (let i = 0; i < corners.length; i++) {
    const p = corners[(i - 1 + corners.length) % corners.length];
    const c = corners[i];
    const q = corners[(i + 1) % corners.length];
    const d0 = norm({ x: c.x - p.x, z: c.z - p.z })!;
    const d1 = norm({ x: q.x - c.x, z: q.z - c.z })!;
    const out = norm({ x: d0.x - d1.x, z: d0.z - d1.z })!;
    const at = { x: c.x + out.x * 9.5, z: c.z + out.z * 9.5 };
    if (inChannel(at.x, QUAY + 2)) continue;
    b.rod(M.frame, [at.x, 0, at.z], [at.x, 7.6, at.z], 0.15, 10, 0.72);
    for (const side of [-1, 1]) {
      const tr = offsetLoop(filleted([p, c, q], TRAM_R), side * TRAM_TRACK).slice(11 + 5, 11 + 6)[0];
      b.detail(() => b.rod(M.frame, [at.x, 6.9, at.z], [tr.x, CONTACT_Y + 0.15, tr.z], 0.025, 4));
    }
    b.detail(() => {
      b.rod(M.frame, [at.x, 0, at.z], [at.x, 0.5, at.z], 0.24, 10);
      b.rod(M.frame, [at.x, 7.6, at.z], [at.x, 7.85, at.z], 0.08, 8, 0.4);
    });
    poles++;
  }

  // The wires: over each track a contact wire zigzagging 20 cm either way from pole to pole, a messenger sagging
  // between the poles and droppers between them, carried across the river on the tram's bridge.
  const phase = (p: V2, q: V2): number => {
    const u = Math.abs(q.x - p.x) > Math.abs(q.z - p.z) ? p.x : p.z;
    return (((u / POLE_STEP) % 1) + 1) % 1;
  };
  const poleIndex = (p: V2, q: V2): number => Math.floor((Math.abs(q.x - p.x) > Math.abs(q.z - p.z) ? p.x : p.z) / POLE_STEP + 1e-6);
  for (const side of [-1, 1]) {
    const track = subdivide(offsetLoop(filleted(corners, TRAM_R), side * TRAM_TRACK), 7, POLE_STEP / 4);
    const runs = closedRuns(track, () => true);
    for (const run of runs) {
      const contact: V3[] = [];
      const messenger: V3[] = [];
      run.forEach((p, i) => {
        const q = run[Math.min(i + 1, run.length - 1)] === p ? run[Math.max(i - 1, 0)] : run[Math.min(i + 1, run.length - 1)];
        const t = norm({ x: q.x - p.x, z: q.z - p.z }) ?? { x: 1, z: 0 };
        const n = { x: -t.z, z: t.x };
        const ph = phase(p, q);
        const k = poleIndex(p, q);
        const s0 = k % 2 ? 0.2 : -0.2;
        const stagger = s0 + (-2 * s0) * ph;
        const y = lift(p);
        contact.push([p.x + n.x * stagger, CONTACT_Y + y, p.z + n.z * stagger]);
        messenger.push([p.x, MESSENGER_Y + y - 0.8 * Math.sin(Math.PI * ph), p.z]);
      });
      b.wire(contact);
      b.wire(messenger);
      for (let i = 0; i < run.length; i++) {
        if (Math.abs(messenger[i][1] - contact[i][1] - (MESSENGER_Y - CONTACT_Y)) < 0.05) continue;
        b.wire([contact[i], messenger[i]]);
      }
    }
  }

  // Stops: a raised platform and a glazed shelter each side.
  let stops = 0;
  for (const st of net.tram.stops) {
    const f = frameFor(st);
    const name = nameAt(TRAM_NAMES, st.x, st.z, names);
    const uv = signs.add(name, 'Tram', 'tram');
    for (const lat of [-1, 1]) tramShelter(b, M, st, f, lat, uv);
    stops++;
  }
  return { poles, stops };
}

/** A stop's frame: along its street and to its lamp-free side. */
function frameFor(s: { x: number; z: number; dir: 'x' | 'z' }): { t: V2; n: V2; at(u: number, l: number): V2; u: number } {
  const t = s.dir === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 };
  const n = s.dir === 'x' ? { x: 0, z: 1 } : { x: 1, z: 0 };
  const u = s.dir === 'x' ? s.x : s.z;
  return { t, n, u, at: (uu, l) => (s.dir === 'x' ? { x: uu, z: s.z + l } : { x: s.x + l, z: uu }) };
}

const at3 = (p: V2, y: number): V3 => [p.x, y, p.z];

/** A centre pole: a tapered steel tube on a base plate, two cantilever arms over the tracks with stays, insulators and registration arms. */
function centrePole(b: Build, M: TransitMaterials, p: V2, t: V2, n: V2, y0 = 0): void {
  b.rod(M.frame, [p.x, y0 + 0, p.z], [p.x, y0 + 7.7, p.z], 0.14, 10, 0.68);
  b.detail(() => {
    b.rod(M.frame, [p.x, y0 + 0, p.z], [p.x, y0 + 0.55, p.z], 0.22, 10, 0.85);
    b.box(M.concrete, p.x, y0 + 0.04, p.z, 0.8, 0.12, 0.8);
    b.rod(M.frame, [p.x, y0 + 7.7, p.z], [p.x, y0 + 7.95, p.z], 0.07, 8, 0.35);
    for (const s of [-1, 1]) {
      const tip = { x: p.x + n.x * s * 2.45, z: p.z + n.z * s * 2.45 };
      b.rod(M.frame, [p.x, y0 + 6.85, p.z], [tip.x, y0 + 6.85, tip.z], 0.045, 6);
      b.rod(M.frame, [p.x, y0 + 7.55, p.z], [tip.x - n.x * s * 0.3, y0 + 6.88, tip.z - n.z * s * 0.3], 0.03, 5);
      // The insulator and the registration arm down to the contact wire.
      b.rod(M.timber, [p.x + n.x * s * 0.35, y0 + 6.85, p.z + n.z * s * 0.35], [p.x + n.x * s * 0.62, y0 + 6.85, p.z + n.z * s * 0.62], 0.055, 8);
      const reg = { x: p.x + n.x * s * TRAM_TRACK, z: p.z + n.z * s * TRAM_TRACK };
      b.rod(M.frame, [reg.x, y0 + 6.85, reg.z], [reg.x + t.x * 0.7, y0 + CONTACT_Y + 0.02, reg.z + t.z * 0.7], 0.018, 4);
    }
  });
}

/**
 * A tram shelter (original): two slim posts at the back, a glazed back
 * screen, a canopy cantilevered toward the kerb with a lit soffit, a timber
 * bench and an end panel with the stop's name. On a raised platform with a
 * pale tactile edge.
 */
function tramShelter(b: Build, M: TransitMaterials, s: Stop, f: ReturnType<typeof frameFor>, lat: number, uv: [number, number, number, number]): void {
  const L = (u: number, l: number, y: number): V3 => at3(f.at(f.u + u, lat * l), y);
  const len = 30;
  // The platform: raised 25 cm over the pavement's edge, from the track's swept edge to the shelter.
  b.sweep(M.concrete, [[0, 0], [0, 0.25], [-2.6, 0.25], [-2.6, 0]].map(([l, h]) => [l * lat, h] as [number, number]), f.at(f.u - len / 2, lat * 3.45), f.at(f.u + len / 2, lat * 3.45), 0, true);
  b.detail(() => {
    const e0 = f.at(f.u - len / 2, lat * 3.75);
    const e1 = f.at(f.u + len / 2, lat * 3.75);
    b.beam(M.paint, at3(e0, 0.255), at3(e1, 0.255), 0.6, 0.012);
  });
  const back = 6.75;
  const top = 2.75;
  // Canopy: a thin plate sloping slightly to the kerb, with a fascia and a lit strip under it.
  const c0 = L(-3.4, back + 0.25, top + 0.12);
  const c1 = L(3.4, back + 0.25, top + 0.12);
  const k0 = L(-3.4, 4.25, top - 0.02);
  const k1 = L(3.4, 4.25, top - 0.02);
  b.beam(M.frame, [(c0[0] + k0[0]) / 2, (c0[1] + k0[1]) / 2, (c0[2] + k0[2]) / 2], [(c1[0] + k1[0]) / 2, (c1[1] + k1[1]) / 2, (c1[2] + k1[2]) / 2], Math.abs(back + 0.25 - 4.25), 0.1);
  b.beam(M.lampWarm, L(-3.2, 5.0, top - 0.09), L(3.2, 5.0, top - 0.09), 0.18, 0.02);
  b.beam(M.lampWarm, L(-3.2, 6.1, top - 0.03), L(3.2, 6.1, top - 0.03), 0.18, 0.02);
  // Posts and the glazed back screen.
  for (const u of [-3.1, 3.1]) b.beam(M.frame, L(u, back, 0.25), L(u, back, top + 0.1), 0.12, 0.12);
  b.beam(M.glassWarm, L(-3.0, back + 0.02, 1.45), L(3.0, back + 0.02, 1.45), 0.03, 2.2);
  // The end panel: a lit name board facing along the street, the side the tram comes from.
  const endP = L(-3.35, back - 0.9, 1.75);
  b.beam(M.frame, L(-3.35, back - 0.15, 0.25), L(-3.35, back - 0.15, top), 0.1, 0.1);
  b.beam(M.frame, L(-3.35, back - 1.75, 0.25), L(-3.35, back - 1.75, top), 0.1, 0.1);
  const faceOut = { x: -f.t.x, z: -f.t.z };
  signPanel(b, M.sign, [endP[0] + faceOut.x * 0.03, 2.1, endP[2] + faceOut.z * 0.03], faceOut, 1.6, 1.6 * SIGN_ASPECT, uv);
  b.beam(M.glassWarm, L(-3.35, back - 0.15, 1.15), L(-3.35, back - 1.75, 1.15), 0.03, 1.3);
  b.detail(() => {
    // The bench: timber slats on two steel brackets.
    for (const u of [-2.0, 2.0]) b.beam(M.frame, L(u, back - 0.35, 0.25), L(u, back - 0.35, 0.72), 0.06, 0.5);
    b.beam(M.timber, L(-2.6, back - 0.4, 0.74), L(2.6, back - 0.4, 0.74), 0.45, 0.05);
    b.beam(M.timber, L(-2.6, back - 0.12, 1.05), L(2.6, back - 0.12, 1.05), 0.06, 0.35);
    // The fascia's edge.
    b.beam(M.frame, L(-3.42, 4.25, top - 0.06), L(3.42, 4.25, top - 0.06), 0.06, 0.24);
  });
}

// ---------------------------------------------------------------- the elevated rail

/** The trough's cross-section: a deck slab with two webs that double as the parapets, lateral to the left. */
const TROUGH: Array<[number, number]> = [
  [-4.5, -1.15],
  [4.5, -1.15],
  [4.5, 0.85],
  [4.1, 0.95],
  [3.85, 0.95],
  [3.85, -0.55],
  [-3.85, -0.55],
  [-3.85, 0.95],
  [-4.1, 0.95],
  [-4.5, 0.85],
];
/** Two ribs under the slab, which the crossheads carry on bearings. */
const RIB: Array<[number, number]> = [
  [-0.55, -1.15],
  [0.55, -1.15],
  [0.4, -2.2],
  [-0.4, -2.2],
];
/** The slab's top, from which the rails rise: top of rail at RAIL_Y. */
const SLAB_TOP = RAIL_Y - 0.55;

function buildRail(b: Build, M: TransitMaterials, net: Network, signs: SignAtlas, names: Set<string>): { bents: number; stations: number } {
  const corners = net.rail.path.map(([x, , z]) => ({ x, z }));
  const centre = filleted(corners, RAIL_R, 8);
  let bents = 0;
  const stations = net.rail.stops;
  const stationAt = (p: V2): Stop | undefined => stations.find((s) => (s.dir === 'x' ? Math.abs(s.z - p.z) < 1 && Math.abs(s.x - p.x) < 27 : Math.abs(s.x - p.x) < 1 && Math.abs(s.z - p.z) < 27));
  const river = (p: V2): boolean => inChannel(p.x, QUAY - 0.6);

  // The deck along the whole loop, cut at every bent: straight runs between supports, the curves in short pieces.
  for (const s of sides(corners)) {
    const f = frameOf(s.a, s.b);
    const u0 = f.dir === 'x' ? s.a.x : s.a.z;
    const u1 = f.dir === 'x' ? s.b.x : s.b.z;
    const sgn = Math.sign(u1 - u0);
    const us = spanSupports(s.a, s.b).filter((u) => Math.abs(u - u0) > RAIL_R + 2 && Math.abs(u - u1) > RAIL_R + 2);
    // Each span's ends: from the curve's end through every support to the next curve.
    const ends = [u0 + sgn * RAIL_R, ...us, u1 - sgn * RAIL_R];
    for (let i = 1; i < ends.length; i++) {
      const a = f.at(ends[i - 1]);
      const c = f.at(ends[i]);
      const mid = { x: (a.x + c.x) / 2, z: (a.z + c.z) / 2 };
      if (river(mid)) {
        riverTruss(b, M, a, c, f);
        continue;
      }
      railSpan(b, M, a, c);
    }
    for (const u of us) {
      const p = f.at(u);
      const st = stationAt(p);
      bent(b, M, p, f.t, f.n, st ? 7.6 : 4.7);
      bents++;
    }
  }
  // The curves: the trough in short pieces, a bent at each curve's middle.
  for (let i = 0; i < corners.length; i++) {
    const p = corners[(i - 1 + corners.length) % corners.length];
    const c = corners[i];
    const q = corners[(i + 1) % corners.length];
    const d0 = norm({ x: c.x - p.x, z: c.z - p.z })!;
    const d1 = norm({ x: q.x - c.x, z: q.z - c.z })!;
    const arc = filleted([p, c, q], RAIL_R, 8).slice(9, 18);
    for (let k = 1; k < arc.length; k++) railSpan(b, M, arc[k - 1], arc[k]);
    const m = arc[4];
    const tm = norm({ x: d0.x + d1.x, z: d0.z + d1.z })!;
    bent(b, M, m, tm, { x: -tm.z, z: tm.x }, 4.7);
    bents++;
  }

  // Stations.
  for (const s of stations) {
    const name = nameAt(RAIL_NAMES, s.x, s.z, names);
    railStation(b, M, s, signs.add(name, 'Elevated', 'rail'));
  }
  return { bents, stations: stations.length };
}

/** One span of trough from a to c: the slab and webs, the ribs, the rails on their plinths, the third rail, a drip and cable tray. */
function railSpan(b: Build, M: TransitMaterials, a: V2, c: V2): void {
  b.sweep(M.concrete, TROUGH, a, c, SLAB_TOP, true);
  for (const s of [-RAIL_TRACK, RAIL_TRACK]) b.sweep(M.concrete, RIB.map(([l, h]) => [l + s, h] as [number, number]), a, c, SLAB_TOP, true);
  b.sweep(M.deckTop, [[-3.84, -0.549], [3.84, -0.549], [3.84, -0.53], [-3.84, -0.53]], a, c, SLAB_TOP);
  b.detail(() => {
    const t = norm({ x: c.x - a.x, z: c.z - a.z })!;
    const n = { x: -t.z, z: t.x };
    const off = (p: V2, l: number): V2 => ({ x: p.x + n.x * l, z: p.z + n.z * l });
    for (const s of [-RAIL_TRACK, RAIL_TRACK]) {
      for (const g of [-GAUGE / 2, GAUGE / 2]) {
        b.beam(M.concrete, at3(off(a, s + g), SLAB_TOP - 0.38), at3(off(c, s + g), SLAB_TOP - 0.38), 0.4, 0.3);
        b.beam(M.railSteel, at3(off(a, s + g), RAIL_Y - 0.08), at3(off(c, s + g), RAIL_Y - 0.08), 0.075, 0.16);
      }
      // The third rail on its insulators, outboard of each track, under a timber cover board.
      b.beam(M.railSteel, at3(off(a, s + Math.sign(s) * 1.45), RAIL_Y - 0.12), at3(off(c, s + Math.sign(s) * 1.45), RAIL_Y - 0.12), 0.08, 0.1);
      b.beam(M.timber, at3(off(a, s + Math.sign(s) * 1.45), RAIL_Y + 0.04), at3(off(c, s + Math.sign(s) * 1.45), RAIL_Y + 0.04), 0.3, 0.04);
    }
    // Cable trays on the webs' outer faces, and the drip line under the slab's edge.
    for (const s of [-1, 1]) {
      b.beam(M.frame, at3(off(a, s * 4.58), SLAB_TOP + 0.35), at3(off(c, s * 4.58), SLAB_TOP + 0.35), 0.16, 0.22);
      b.beam(M.frame, at3(off(a, s * 4.15), SLAB_TOP + 1.12), at3(off(c, s * 4.15), SLAB_TOP + 1.12), 0.05, 0.3);
    }
  });
}

/**
 * A bent: two round concrete piers on plinths and a tapered crosshead, with
 * bearing pads under the ribs, a downpipe and an uplight at each pier's
 * foot. `half` is the crosshead's half-length (wider under a station).
 */
function bent(b: Build, M: TransitMaterials, p: V2, t: V2, n: V2, half: number): void {
  const L = (l: number, y: number): V3 => [p.x + n.x * l, y, p.z + n.z * l];
  const capTop = SLAB_TOP - 2.2 - 0.12;
  for (const s of [-3.2, 3.2]) {
    b.rod(M.concrete, L(s, 0), L(s, capTop - 1.4), 0.55, 14);
    b.detail(() => {
      b.box(M.concrete, ...L(s, 0.2), 1.5, 0.4, 1.5, Math.atan2(t.x, t.z));
      b.rod(M.frame, L(s + Math.sign(s) * 0.62, 0.2), L(s + Math.sign(s) * 0.62, capTop - 1.5), 0.05, 6);
      b.box(M.lampWarm, ...L(s + Math.sign(s) * 0.9, 0.12), 0.25, 0.06, 0.25);
    });
  }
  // The crosshead: deeper over the piers, chamfered at its ends.
  const head: Array<[number, number]> = [
    [-half, 0],
    [-half + 0.9, -1.4],
    [half - 0.9, -1.4],
    [half, 0],
  ];
  const a = { x: p.x - t.x * 0.9, z: p.z - t.z * 0.9 };
  const c = { x: p.x + t.x * 0.9, z: p.z + t.z * 0.9 };
  b.sweep(
    M.concrete,
    head.map(([l, h]) => [l, h] as [number, number]),
    a,
    c,
    capTop,
    true,
  );
  b.detail(() => {
    for (const s of [-RAIL_TRACK, RAIL_TRACK]) b.box(M.frame, ...L(s, capTop + 0.06), 0.9, 0.12, 0.9, Math.atan2(t.x, t.z));
  });
}

/** The river span: a steel Warren truss with verticals, the deck slung inside it between the chords. */
function riverTruss(b: Build, M: TransitMaterials, a: V2, c: V2, f: { t: V2; n: V2 }): void {
  const len = Math.hypot(c.x - a.x, c.z - a.z);
  const panels = Math.max(4, Math.round(len / 8));
  const H = 7.4;
  const y0 = SLAB_TOP - 1.0;
  const P = (u: number, l: number, y: number): V3 => [a.x + f.t.x * u + f.n.x * l, y, a.z + f.t.z * u + f.n.z * l];
  for (const s of [-4.7, 4.7]) {
    // Chords: the bottom along the deck, the top shortened by the inclined end posts.
    b.beam(M.truss, P(0, s, y0), P(len, s, y0), 0.7, 1.0);
    b.beam(M.truss, P(len / panels, s, y0 + H), P(len - len / panels, s, y0 + H), 0.7, 0.8);
    b.beam(M.truss, P(0, s, y0), P(len / panels, s, y0 + H), 0.6, 0.6);
    b.beam(M.truss, P(len, s, y0), P(len - len / panels, s, y0 + H), 0.6, 0.6);
    for (let k = 1; k < panels; k++) {
      const u = (k * len) / panels;
      b.beam(M.truss, P(u, s, y0), P(u, s, y0 + H), 0.4, 0.35);
      if (k < panels - 1) {
        const up = k % 2 === 1;
        b.beam(M.truss, P(u, s, up ? y0 : y0 + H), P(u + len / panels, s, up ? y0 + H : y0), 0.36, 0.36);
      }
    }
  }
  // Floor beams and the deck, top laterals and portals.
  b.sweep(M.concrete, [[-4.4, -0.75], [4.4, -0.75], [4.4, 0.3], [-4.4, 0.3]], { x: P(0, 0, 0)[0], z: P(0, 0, 0)[2] }, { x: P(len, 0, 0)[0], z: P(len, 0, 0)[2] }, SLAB_TOP - 0.25, true);
  b.sweep(M.deckTop, [[-3.84, 0.301], [3.84, 0.301], [3.84, 0.32], [-3.84, 0.32]], { x: P(0, 0, 0)[0], z: P(0, 0, 0)[2] }, { x: P(len, 0, 0)[0], z: P(len, 0, 0)[2] }, SLAB_TOP - 0.25);
  for (let k = 1; k < panels; k++) {
    const u = (k * len) / panels;
    b.beam(M.truss, P(u, -4.7, y0 + H), P(u, 4.7, y0 + H), 0.3, 0.45);
  }
  b.detail(() => {
    for (let k = 1; k < panels - 1; k++) {
      const u0 = (k * len) / panels;
      const u1 = ((k + 1) * len) / panels;
      b.beam(M.truss, P(u0, -4.7, y0 + H + 0.2), P(u1, 4.7, y0 + H + 0.2), 0.12, 0.12);
      b.beam(M.truss, P(u0, 4.7, y0 + H + 0.2), P(u1, -4.7, y0 + H + 0.2), 0.12, 0.12);
    }
    for (let k = 0; k <= panels; k++) {
      const u = (k * len) / panels;
      b.beam(M.truss, P(u, -4.7, y0 - 0.2), P(u, 4.7, y0 - 0.2), 0.3, 0.6);
    }
    const off = (u: number, l: number): V2 => ({ x: a.x + f.t.x * u + f.n.x * l, z: a.z + f.t.z * u + f.n.z * l });
    for (const s of [-RAIL_TRACK, RAIL_TRACK]) for (const g of [-GAUGE / 2, GAUGE / 2]) b.beam(M.railSteel, at3(off(0, s + g), RAIL_Y - 0.08), at3(off(len, s + g), RAIL_Y - 0.08), 0.075, 0.16);
    // A red light on each portal for the river's boats.
    for (const u of [len / 2]) for (const s of [-4.7, 4.7]) b.box(M.red, ...P(u, s, y0 - 0.85), 0.25, 0.25, 0.25);
  });
}

/**
 * A rail station (original): side platforms at the trains' floor on wider
 * crossheads, a single steel roof over both platforms and the tracks with a
 * glazed clerestory, a lit windscreen along each platform's back, strip
 * lights under the roof, a ticket hall slung under the deck between the
 * piers, a stair down to the lamp-free pavement and the name along each end.
 */
function railStation(b: Build, M: TransitMaterials, s: Stop, uv: [number, number, number, number]): void {
  const f = frameFor(s);
  const L = (u: number, l: number, y: number): V3 => at3(f.at(f.u + u, l), y);
  const half = 24;
  const plat = RAIL_Y + 0.95;
  for (const side of [-1, 1]) {
    // Platform slab from the edge by the track to the windscreen.
    b.sweep(M.concrete, [[0, 0], [0, -0.45], [3.4, -0.45], [3.4, 0]].map(([l, h]) => [side * (3.55 + l), h] as [number, number]).map(([l, h]) => (side > 0 ? [l, h] : [l, h]) as [number, number]), f.at(f.u - half, 0), f.at(f.u + half, 0), plat, true);
    // The platform's finish: paving slabs laid over the slab, and a yellow blister strip along the edge.
    b.detail(() => {
      b.beam(M.paving, L(-half, side * 5.55, plat + 0.006), L(half, side * 5.55, plat + 0.006), 2.75, 0.012);
      b.beam(M.tactile, L(-half, side * 3.92, plat + 0.008), L(half, side * 3.92, plat + 0.008), 0.6, 0.016);
    });
    // Windscreen and roof columns.
    b.beam(M.glassWarm, L(-half + 0.3, side * 6.9, plat + 1.25), L(half - 0.3, side * 6.9, plat + 1.25), 0.04, 2.5);
    for (let u = -half + 0.2; u <= half - 0.1; u += 6) b.beam(M.frame, L(u, side * 6.95, plat), L(u, side * 6.95, plat + 4.0), 0.22, 0.3);
    // The roof's lit strips over each platform, every 6 m.
    for (let u = -half + 3; u < half - 1; u += 6) b.beam(M.lampWarm, L(u - 2.0, side * 5.3, plat + 3.62), L(u + 2.0, side * 5.3, plat + 3.62), 0.16, 0.03);
    b.detail(() => {
      // Benches against the windscreen, the canopy's eaves gutter.
      for (let u = -half + 9; u < half - 4; u += 12) b.beam(M.timber, L(u - 1.2, side * 6.45, plat + 0.45), L(u + 1.2, side * 6.45, plat + 0.45), 0.45, 0.06);
      b.beam(M.frame, L(-half, side * 7.25, plat + 4.0), L(half, side * 7.25, plat + 4.0), 0.22, 0.25);
    });
  }
  // The roof: a shallow-pitched plate over everything, with a raised glazed clerestory over the tracks.
  const roofY = plat + 3.75;
  b.sweep(M.roof, [[-7.35, 0], [-2.8, 0.55], [-2.8, 0.75], [-7.45, 0.18]], f.at(f.u - half - 0.6, 0), f.at(f.u + half + 0.6, 0), roofY, true);
  b.sweep(M.roof, [[2.8, 0.55], [7.35, 0], [7.45, 0.18], [2.8, 0.75]], f.at(f.u - half - 0.6, 0), f.at(f.u + half + 0.6, 0), roofY, true);
  b.sweep(M.glassWarm, [[-2.8, 0.75], [-2.8, 1.65], [2.8, 1.65], [2.8, 0.75]], f.at(f.u - half - 0.6, 0), f.at(f.u + half + 0.6, 0), roofY);
  b.sweep(M.roof, [[-3.1, 1.6], [3.1, 1.6], [3.1, 1.8], [-3.1, 1.8]], f.at(f.u - half - 0.8, 0), f.at(f.u + half + 0.8, 0), roofY, true);
  // The names along each end, under the roof's edge, facing up and down the street.
  for (const e of [-1, 1]) {
    const face = { x: f.t.x * e, z: f.t.z * e };
    const p = L(e * (half + 0.62), 0, roofY + 0.55);
    signPanel(b, M.sign, [p[0], p[1], p[2]], face, 5.6, 5.6 * SIGN_ASPECT, uv);
  }
  // The ticket hall under the deck: a lit glass box between the piers (clear of the street lamps 8 m either side
  // of the block's centre), its floor and roof slabs.
  const hall0 = 6.2;
  const hall1 = 9.15;
  const hu = 6.3;
  const hl = 6.6;
  b.box(M.concrete, ...L(0, 0, hall0 - 0.2), f.t.x ? 2 * hu + 0.4 : 2 * hl + 0.4, 0.4, f.t.x ? 2 * hl + 0.4 : 2 * hu + 0.4);
  b.box(M.concrete, ...L(0, 0, hall1 + 0.1), f.t.x ? 2 * hu + 0.4 : 2 * hl + 0.4, 0.2, f.t.x ? 2 * hl + 0.4 : 2 * hu + 0.4);
  for (const side of [-1, 1]) b.beam(M.glassWarm, L(-hu, side * hl, (hall0 + hall1) / 2), L(hu, side * hl, (hall0 + hall1) / 2), 0.04, hall1 - hall0);
  for (const e of [-1, 1]) b.beam(M.glassWarm, L(e * hu, -hl, (hall0 + hall1) / 2), L(e * hu, hl, (hall0 + hall1) / 2), 0.04, hall1 - hall0);
  // The hall's name on its street side.
  {
    const p = L(0, hl + 0.06, hall1 - 0.45);
    signPanel(b, M.sign, p, f.n, 4.2, 4.2 * SIGN_ASPECT, uv);
  }
  // The stair: from the hall's floor down to the lamp-free pavement, two flights and a landing.
  const lat = 5.6;
  const w = 2.0;
  const top = hall0;
  const flights: Array<[number, number, number, number]> = [
    [hu + 0.2, top, hu + 5.4, top / 2],
    [hu + 7.0, top / 2, hu + 12.2, 0],
  ];
  for (const [u0, y0, u1, y1] of flights) {
    const run = u1 - u0;
    const steps = Math.round((y0 - y1) / 0.17);
    for (const sd of [-w / 2, w / 2]) b.beam(M.frame, L(u0, lat + sd, y0 - 0.2), L(u1, lat + sd, y1 - 0.2), 0.12, 0.35);
    // The flight's sloped soffit, so it reads from afar.
    b.beam(M.concrete, L(u0, lat, y0 - 0.12), L(u1, lat, y1 - 0.12), w, 0.18);
    b.detail(() => {
      for (let k = 0; k < steps; k++) {
        const u = u0 + ((k + 0.5) * run) / steps;
        const y = y0 - ((k + 1) * (y0 - y1)) / steps;
        b.box(M.concrete, ...L(u, lat, y + 0.08), f.t.x ? run / steps + 0.02 : w, 0.16, f.t.x ? w : run / steps + 0.02);
      }
      for (const sd of [-w / 2, w / 2]) b.beam(M.frame, L(u0, lat + sd, y0 + 0.95), L(u1, lat + sd, y1 + 0.95), 0.05, 0.05);
    });
  }
  b.box(M.concrete, ...L(hu + 6.2, lat, top / 2 - 0.1), f.t.x ? 1.8 : w + 0.2, 0.25, f.t.x ? w + 0.2 : 1.8);
  for (const sd of [-w / 2, w / 2]) b.beam(M.frame, L(hu + 6.2, lat + sd, 0), L(hu + 6.2, lat + sd, top / 2 - 0.2), 0.14, 0.14);
}

// ---------------------------------------------------------------- the pods

/** Each guideway beam's section: a faired steel box, its running face at POD_Y. */
const POD_BOX: Array<[number, number]> = [
  [-0.52, 0],
  [-0.62, -0.2],
  [-0.4, -0.95],
  [0.4, -0.95],
  [0.62, -0.2],
  [0.52, 0],
];

function buildPods(b: Build, M: TransitMaterials, net: Network, signs: SignAtlas, names: Set<string>): { pylons: number; stations: number } {
  let pylons = 0;
  let stations = 0;
  const top = POD_Y;
  for (const line of net.pods) {
    const a = { x: line.path[0][0], z: line.path[0][2] };
    const c = { x: line.path[1][0], z: line.path[1][2] };
    const f = frameOf(a, c);
    const u0 = f.dir === 'x' ? a.x : a.z;
    const u1 = f.dir === 'x' ? c.x : c.z;
    // Pylons every 40 m, 20 m either side of each crossing; at the river, on each quay's edge.
    const us = spanSupports(a, c, [20, 60]);
    if (f.dir === 'x') for (const q of [BANKS.west - QUAY, BANKS.east + QUAY]) if (q > Math.min(u0, u1) && q < Math.max(u0, u1)) us.push(q);
    us.sort((p, q) => p - q);
    const stops = line.stops;
    const station = (u: number): Stop | undefined => stops.find((s) => Math.abs((f.dir === 'x' ? s.x : s.z) - u) < (s.interchange ? 14 : 18));
    const ends = [u0, ...us, u1];
    for (let i = 1; i < ends.length; i++) {
      const p = f.at(ends[i - 1]);
      const q = f.at(ends[i]);
      const mid = (ends[i - 1] + ends[i]) / 2;
      // Over the river: a bowstring arch over the two beams.
      if (f.dir === 'x' && inChannel(f.at(mid).x, 0)) podBowstring(b, M, p, q, f);
      for (const s of [-POD_BEAM, POD_BEAM]) {
        const off = (v: V2): V2 => ({ x: v.x + f.n.x * s, z: v.z + f.n.z * s });
        b.sweep(M.podSteel, POD_BOX, off(p), off(q), top - 0.05, true);
        // The lit line along each beam's outer face, and the running rails.
        const o = Math.sign(s) * 0.6;
        b.beam(M.lampCool, at3({ x: off(p).x + f.n.x * o, z: off(p).z + f.n.z * o }, top - 0.32), at3({ x: off(q).x + f.n.x * o, z: off(q).z + f.n.z * o }, top - 0.32), 0.03, 0.05);
        b.detail(() => {
          for (const g of [-0.45, 0.45]) b.beam(M.railSteel, at3({ x: off(p).x + f.n.x * g, z: off(p).z + f.n.z * g }, top + 0.04), at3({ x: off(q).x + f.n.x * g, z: off(q).z + f.n.z * g }, top + 0.04), 0.14, 0.1);
        });
      }
    }
    for (const u of us) {
      if (station(u)) continue;
      podPylon(b, M, f.at(u), f.n, top);
      pylons++;
    }
    // The line's ends: buffer blocks on a last pylon.
    for (const u of [u0, u1]) {
      podPylon(b, M, f.at(u), f.n, top);
      pylons++;
    }
    for (const s of stops) {
      if (s.interchange && line !== net.pods[0]) continue;
      const name = s.interchange ? 'Interchange' : (s.x === 0 || s.z === 0) && Math.abs(s.x) + Math.abs(s.z) < 200 ? 'Exchange' : nameAt(POD_NAMES, s.x, s.z, names);
      podStation(b, M, s, f, signs.add(name, s.interchange ? 'Both lines' : 'Pods', 'pod'));
      stations++;
    }
  }
  return { pylons, stations };
}

/** A pylon: a tapered round steel column in the median, forking into a Y that carries both beams. */
function podPylon(b: Build, M: TransitMaterials, p: V2, n: V2, top: number): void {
  const fork = top - 4.2;
  b.rod(M.podSteel, [p.x, 0, p.z], [p.x, fork, p.z], 0.62, 16, 0.72);
  for (const s of [-1, 1]) {
    const tip: V3 = [p.x + n.x * s * POD_BEAM, top - 1.2, p.z + n.z * s * POD_BEAM];
    b.rod(M.podSteel, [p.x, fork - 0.3, p.z], tip, 0.3, 10, 0.75);
  }
  b.box(M.podSteel, p.x, top - 1.3, p.z, n.x ? 4.6 : 1.1, 0.35, n.x ? 1.1 : 4.6);
  b.detail(() => {
    b.rod(M.concrete, [p.x, 0, p.z], [p.x, 0.35, p.z], 1.05, 16);
    b.rod(M.podSteel, [p.x, fork - 0.5, p.z], [p.x, fork + 0.2, p.z], 0.5, 16, 0.85);
    // A small cool uplight at the foot washing the column.
    b.box(M.lampCool, p.x + n.x * 1.0, 0.37, p.z + n.z * 1.0, 0.2, 0.04, 0.2);
  });
}

/** Over the river: a white bowstring arch on each side of the guideway, with thin hangers to the beams. */
function podBowstring(b: Build, M: TransitMaterials, p: V2, q: V2, f: { t: V2; n: V2 }): void {
  const len = Math.hypot(q.x - p.x, q.z - p.z);
  const rise = 10;
  const seg = 16;
  for (const s of [-1, 1]) {
    const l = s * (POD_BEAM + 1.1);
    const pt = (k: number): V3 => {
      const u = (k / seg) * len;
      const y = POD_Y - 0.8 + rise * (1 - Math.pow((2 * u) / len - 1, 2));
      return [p.x + f.t.x * u + f.n.x * l, y, p.z + f.t.z * u + f.n.z * l];
    };
    for (let k = 0; k < seg; k++) b.beam(M.podSteel, pt(k), pt(k + 1), 0.55, 0.7);
    for (let k = 2; k < seg - 1; k += 1) {
      const top = pt(k);
      const foot: V3 = [top[0] - f.n.x * s * 0.9, POD_Y - 0.6, top[2] - f.n.z * s * 0.9];
      b.rod(M.podSteel, top, foot, 0.045, 6);
    }
  }
  // Wind bracing across the crown.
  for (let k = 4; k <= 12; k += 4) {
    const u = (k / seg) * len;
    const y = POD_Y - 0.8 + rise * (1 - Math.pow((2 * u) / len - 1, 2));
    const A: V3 = [p.x + f.t.x * u - f.n.x * (POD_BEAM + 1.1), y, p.z + f.t.z * u - f.n.z * (POD_BEAM + 1.1)];
    const B: V3 = [p.x + f.t.x * u + f.n.x * (POD_BEAM + 1.1), y, p.z + f.t.z * u + f.n.z * (POD_BEAM + 1.1)];
    b.beam(M.podSteel, A, B, 0.3, 0.3);
  }
}

/**
 * A pod station (original): a glass box straddling both guideways, its
 * glass clear and faintly green so the room reads through it. Inside, a
 * platform along each side at the pods' floor with a stone floor, timber
 * benches, a glazed screen with handrail along the track edge, a lit
 * ceiling with luminaire rows, and hanging name boards; between the
 * platforms the beams run through open. Under it, a dark soffit with
 * downlights on two median columns; on the lamp-free pavement, a glass lift
 * with its car and a bridge across. The interchange is a square hall over
 * the crossing with a platform round all four sides, its corner piers
 * carried up through the roof, and a lit lantern over the middle.
 */
function podStation(b: Build, M: TransitMaterials, s: Stop, f: { t: V2; n: V2; dir: 'x' | 'z' }, uv: [number, number, number, number]): void {
  const ff = frameFor(s);
  const L = (u: number, l: number, y: number): V3 => at3(ff.at(ff.u + u, l), y);
  /** A box by its extent along the line (su) and across it (sl). */
  const bx = (mat: THREE.Material, u: number, l: number, y: number, su: number, sy: number, sl: number): void => b.box(mat, ...L(u, l, y), f.dir === 'x' ? su : sl, sy, f.dir === 'x' ? sl : su);
  const ix = !!s.interchange;
  const half = ix ? 11 : 15;
  const wide = ix ? 11 : 4.6;
  const floor = POD_Y + 0.35;
  const y0 = POD_Y - 1.6;
  const y1 = floor + 3.6;
  const inner = 2.75;
  // The platforms: a stone floor along each side (round all four in the interchange), its fascia and soffit below.
  const platforms: Array<{ u: number; l: number; su: number; sl: number }> = [];
  for (const side of [-1, 1]) platforms.push({ u: 0, l: side * (inner + wide) / 2, su: 2 * half, sl: wide - inner });
  if (ix) for (const e of [-1, 1]) platforms.push({ u: e * (inner + half) / 2, l: 0, su: half - inner, sl: 2 * inner });
  for (const p of platforms) {
    bx(M.podFloor, p.u, p.l, floor - 0.15, p.su, 0.3, p.sl);
    bx(M.podSteel, p.u, p.l, floor - 0.6, p.su, 0.6, p.sl);
    bx(M.frame, p.u, p.l, (y0 + floor - 0.9) / 2, p.su - 0.6, floor - 0.9 - y0, p.sl - 0.6);
    // Downlights in the soffit over the street.
    const n = Math.max(1, Math.floor(p.su / 5));
    for (let k = 0; k < n; k++) bx(M.lampWarm, p.u - p.su / 2 + (k + 0.5) * (p.su / n), p.l, y0 - 0.03, 0.35, 0.03, 0.35);
  }
  // The roof, its lit ceiling and the reveal between roof and glass.
  bx(M.podSteel, 0, 0, y1 + 0.3, 2 * half + 1.4, 0.6, 2 * wide + 1.4);
  bx(M.ceiling, 0, 0, y1 - 0.03, 2 * half, 0.06, 2 * wide);
  bx(M.lampCool, 0, 0, y1 + 0.02, 2 * half + 0.15, 0.05, 2 * wide + 0.15);
  for (const side of [-1, 1]) {
    const l = side * (inner + wide) / 2;
    if (ix) {
      for (const e of [-1, 1]) bx(M.lampWarm, 0, e * (inner + wide) / 2, y1 - 0.08, 2 * half - 1.5, 0.04, 0.22);
      bx(M.lampWarm, side * (inner + half) / 2, 0, y1 - 0.08, 0.22, 0.04, 2 * inner);
    } else bx(M.lampWarm, 0, l, y1 - 0.08, 2 * half - 1.5, 0.04, 0.22);
  }
  // Clear glass on all four sides, with slim fins outside every 3 m and a dark sill.
  for (const side of [-1, 1]) {
    b.beam(M.glassClear, L(-half, side * wide, (floor + y1) / 2), L(half, side * wide, (floor + y1) / 2), 0.04, y1 - floor);
    b.beam(M.glassClear, L(side * half, -wide, (floor + y1) / 2), L(side * half, wide, (floor + y1) / 2), 0.04, y1 - floor);
    for (let u = -half; u <= half + 0.01; u += 3) bx(M.podSteel, u, side * (wide + 0.1), (floor + y1) / 2, 0.14, y1 - floor, 0.24);
    for (let l = -wide; l <= wide + 0.01; l += 3) if (ix || Math.abs(l) > inner) bx(M.podSteel, side * (half + 0.1), l, (floor + y1) / 2, 0.24, y1 - floor, 0.14);
    bx(M.frame, 0, side * wide, floor + 0.06, 2 * half, 0.12, 0.2);
  }
  // Along each track edge: a glazed screen with doors every 5 m, a steel handrail, and benches against the glass.
  const edges: Array<{ along: 'u' | 'l'; at: number; from: number; to: number }> = [];
  for (const side of [-1, 1]) edges.push({ along: 'u', at: side * inner, from: -half, to: half });
  if (ix) for (const e of [-1, 1]) edges.push({ along: 'l', at: e * inner, from: -inner, to: inner });
  for (const e of edges) {
    const P = (v: number, y: number): V3 => (e.along === 'u' ? L(v, e.at, y) : L(e.at, v, y));
    const span = e.to - e.from;
    if (ix && e.along === 'u') {
      // In the interchange the cross line passes through the middle of these edges: screens either side of it.
      for (const [a0, a1] of [[e.from, -inner], [inner, e.to]] as Array<[number, number]>) {
        b.beam(M.glassClear, P(a0, floor + 1.1), P(a1, floor + 1.1), 0.03, 2.2);
        b.beam(M.frame, P(a0, floor + 2.25), P(a1, floor + 2.25), 0.1, 0.1);
      }
    } else {
      b.beam(M.glassClear, P(e.from, floor + 1.1), P(e.to, floor + 1.1), 0.03, 2.2);
      b.beam(M.frame, P(e.from, floor + 2.25), P(e.to, floor + 2.25), 0.1, 0.1);
    }
    b.detail(() => {
      for (let v = e.from; v <= e.to + 0.01; v += 2.5) b.beam(M.frame, P(v, floor), P(v, floor + 2.2), 0.06, 0.06);
      b.beam(M.railSteel, P(e.from, floor + 1.0), P(e.to, floor + 1.0), 0.05, 0.05);
    });
    void span;
  }
  b.detail(() => {
    for (const side of [-1, 1]) {
      const l = side * (wide - 0.55);
      for (let u = -half + 4; u < half - 3; u += 8) {
        bx(M.timber, u, l, floor + 0.45, 2.4, 0.06, 0.5);
        bx(M.timber, u, side * (wide - 0.32), floor + 0.75, 2.4, 0.5, 0.05);
        for (const d of [-0.9, 0.9]) bx(M.frame, u + d, l, floor + 0.22, 0.06, 0.44, 0.45);
      }
    }
  });
  // Wayfinding: a lit board hung from the ceiling over each platform, facing along it, and a totem at each end.
  for (const side of [-1, 1]) {
    const l = side * (inner + wide) / 2;
    for (const e of [-1, 1]) {
      const face = { x: f.t.x * e, z: f.t.z * e };
      const p = L(e * 0.04, l, y1 - 0.75);
      signPanel(b, M.sign, p, face, 1.7, 1.7 * SIGN_ASPECT * 1.6, uv);
    }
    b.beam(M.frame, L(0, l, y1 - 0.62), L(0, l, y1 - 0.05), 0.03, 0.03);
    bx(M.frame, half - 1.2, side * (wide - 0.6), floor + 1.0, 0.35, 2.0, 0.12);
    signPanel(b, M.sign, L(half - 1.4, side * (wide - 0.6), floor + 1.7), { x: -f.t.x, z: -f.t.z }, 0.9, 0.9 * SIGN_ASPECT * 1.6, uv);
  }
  // Columns: two in the median under crossheads; in the interchange four corner piers carried up through the roof.
  if (ix) {
    for (const su of [-1, 1]) for (const sl of [-1, 1]) bx(M.podSteel, su * 6.4, sl * 6.4, (y1 + 2.2) / 2, 0.9, y1 + 2.2, 0.9);
    // The lantern: a lit glass clerestory over the middle with its own thin roof.
    for (const side of [-1, 1]) {
      b.beam(M.glassWarm, L(-4.5, side * 4.5, y1 + 1.6), L(4.5, side * 4.5, y1 + 1.6), 0.05, 2.0);
      b.beam(M.glassWarm, L(side * 4.5, -4.5, y1 + 1.6), L(side * 4.5, 4.5, y1 + 1.6), 0.05, 2.0);
    }
    bx(M.podSteel, 0, 0, y1 + 2.75, 10.6, 0.3, 10.6);
    bx(M.lampCool, 0, 0, y1 + 2.58, 9.2, 0.04, 9.2);
  } else {
    for (const su of [-1, 1]) {
      b.rod(M.podSteel, L(su * 9, 0, 0), L(su * 9, 0, y0 - 0.6), 0.7, 16, 0.75);
      b.beam(M.podSteel, L(su * 9, -wide + 0.4, y0 - 0.35), L(su * 9, wide - 0.4, y0 - 0.35), 1.0, 0.7);
    }
  }
  // The lift: a clear shaft on the lamp-free pavement, its car halfway up, a white crown, a bridge across.
  const lu = ix ? 8.6 : -12;
  const ll = ix ? 8.6 : 6.2;
  const sh = 1.25;
  for (const side of [-1, 1]) {
    b.beam(M.glassClear, L(lu - sh, ll + side * sh, (y1 + 0.5) / 2), L(lu + sh, ll + side * sh, (y1 + 0.5) / 2), 0.04, y1 - 0.5);
    b.beam(M.glassClear, L(lu + side * sh, ll - sh, (y1 + 0.5) / 2), L(lu + side * sh, ll + sh, (y1 + 0.5) / 2), 0.04, y1 - 0.5);
  }
  for (const su of [-1, 1]) for (const sl of [-1, 1]) b.beam(M.podSteel, L(lu + su * sh, ll + sl * sh, 0), L(lu + su * sh, ll + sl * sh, y1 + 0.6), 0.14, 0.14);
  bx(M.podSteel, lu, ll, y1 + 0.75, 2 * sh + 0.5, 0.5, 2 * sh + 0.5);
  bx(M.podSteel, lu, ll, 0.15, 2 * sh + 0.4, 0.3, 2 * sh + 0.4);
  bx(M.podSteel, lu, ll, 9.5, 1.8, 2.4, 1.8);
  bx(M.lampWarm, lu, ll, 10.66, 1.4, 0.04, 1.4);
  if (!ix) {
    bx(M.podFloor, lu, (wide + ll - sh) / 2, floor - 0.15, 2.2, 0.3, ll - sh - wide);
    bx(M.glassClear, lu, (wide + ll - sh) / 2, floor + 1.3, 2.2, 2.6, ll - sh - wide);
    bx(M.podSteel, lu, (wide + ll - sh) / 2, floor + 2.7, 2.4, 0.2, ll - sh - wide);
  }
  // The name on each end's roof fascia, and on the street sides.
  for (const e of [-1, 1]) {
    const face = { x: f.t.x * e, z: f.t.z * e };
    signPanel(b, M.sign, L(e * (half + 0.72), 0, y1 + 0.3), face, 4.6, 4.6 * SIGN_ASPECT, uv);
  }
  for (const side of [-1, 1]) {
    if (!ix && side < 0) continue;
    const face = { x: f.n.x * side, z: f.n.z * side };
    signPanel(b, M.sign, L(0, side * (wide + 0.72), y1 + 0.3), face, 6.0, 6.0 * SIGN_ASPECT, uv);
  }
}

// ---------------------------------------------------------------- cab ranks

/** A cab rank: three bays marked in the kerb lane, dashed dividers, and a lit sign on a post at the kerb. */
function cabRank(b: Build, M: TransitMaterials, r: Rank, uv: [number, number, number, number]): void {
  const along = r.dir === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 };
  const side = r.dir === 'x' ? { x: 0, z: 1 } : { x: 1, z: 0 };
  const P = (u: number, l: number, y: number): V3 => [r.x + along.x * u + side.x * l, y, r.z + along.z * u + side.z * l];
  const bays = 3;
  const bay = 6.5;
  const len = bays * bay;
  // The box: its outer lines, and dashes between the bays.
  b.beam(M.paint, P(-len / 2, -1.6, 0.012), P(len / 2, -1.6, 0.012), 0.15, 0.01);
  b.beam(M.paint, P(-len / 2, 1.6, 0.012), P(len / 2, 1.6, 0.012), 0.15, 0.01);
  for (let k = 0; k <= bays; k++) {
    const u = -len / 2 + k * bay;
    if (k === 0 || k === bays) b.beam(M.paint, P(u, -1.6, 0.012), P(u, 1.6, 0.012), 0.15, 0.01);
    else for (let d = -1.4; d < 1.4; d += 0.8) b.beam(M.paint, P(u, d, 0.012), P(u, d + 0.4, 0.012), 0.15, 0.01);
  }
  // The sign: a slim post at the kerb and a lit two-faced box.
  const post = P(len / 2 - 1.0, 4.2, 0);
  b.rod(M.frame, post, [post[0], 3.3, post[2]], 0.06, 8);
  b.box(M.frame, post[0], 3.05, post[2], r.dir === 'x' ? 0.12 : 1.1, 0.5, r.dir === 'x' ? 1.1 : 0.12);
  for (const e of [-1, 1]) {
    const face = { x: along.x * e, z: along.z * e };
    const mid: [number, number, number, number] = [uv[0] + (uv[2] - uv[0]) * 0.36, uv[1], uv[0] + (uv[2] - uv[0]) * 0.64, uv[3]];
    signPanel(b, M.sign, [post[0] + face.x * 0.065, 3.05, post[2] + face.z * 0.065], face, 0.96, (0.96 * SIGN_ASPECT) / 0.28, mid);
  }
  b.detail(() => b.box(M.lampWarm, post[0], 2.76, post[2], 0.3, 0.03, 0.3));
}

// ---------------------------------------------------------------- the network

export interface TransitView {
  /** Meshes and triangles of the network the camera sees now (the main pass). */
  meshes: number;
  triangles: number;
  stops: number;
  stations: number;
  podStations: number;
  ranks: number;
  poles: number;
  bents: number;
  pylons: number;
  /** The extent the network is laid for, in district rings. */
  blocks: number;
  /** How many times the network has been laid, and how long the last took, in ms. */
  builds: number;
  buildMs: number;
}

export interface Transit {
  group: THREE.Group;
  /**
   * Lays the network for the city as it stands: the loops for its extent,
   * a cab rank at each district plaza. Rebuilds only when either changed.
   */
  set(extent: NetworkExtent): boolean;
  /** Sets each chunk's detail, shadow and AO from the eye. True when the shadow casters changed. */
  update(eye: THREE.Vector3, fogDensity: number): boolean;
  /** The network as laid now, or null before the city has districts. */
  network(): Network | null;
  view(camera: THREE.Camera): TransitView;
  dispose(): void;
}

export function createTransit(): Transit {
  const L = materials();
  const setts = settsTexture();
  const signs = new SignAtlas();
  const M: TransitMaterials = {
    concrete: concreteMaterial(),
    deckTop: new THREE.MeshStandardMaterial({ color: 0x3b3834, roughness: 0.95 }),
    railSteel: new THREE.MeshStandardMaterial({ color: 0xa29a90, metalness: 1, roughness: 0.3 }),
    frame: L.darkMetal,
    truss: upwashed(new THREE.MeshStandardMaterial({ color: 0x4a5c58, metalness: 0.5, roughness: 0.45 }), 'truss', 10.5, 7, 0.4),
    podSteel: shadedSteel(),
    roof: new THREE.MeshStandardMaterial({ color: 0x2b2c2e, metalness: 0.6, roughness: 0.5 }),
    setts: new THREE.MeshStandardMaterial({ map: setts, color: 0x9a948c, roughness: 0.82 }),
    paint: new THREE.MeshStandardMaterial({ color: 0xd8d2bf, roughness: 0.7, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    timber: new THREE.MeshStandardMaterial({ color: 0x5a4532, roughness: 0.8 }),
    glassWarm: litGlass('glass-warm', new THREE.Color(1.0, 0.76, 0.5), 0.55),
    paving: pavingMaterial(),
    tactile: tactileMaterial(),
    glassCool: litGlass('glass-cool', new THREE.Color(1.0, 0.9, 0.76), 0.85),
    glassClear: new THREE.MeshStandardMaterial({ color: 0x8fa9a6, transparent: true, opacity: 0.2, roughness: 0.04, metalness: 0, envMapIntensity: 1.5, depthWrite: false }),
    podFloor: new THREE.MeshStandardMaterial({ color: 0xcfc9bd, roughness: 0.5, emissive: new THREE.Color(1.0, 0.86, 0.68), emissiveIntensity: 0.32 }),
    ceiling: new THREE.MeshStandardMaterial({ color: 0xe6e1d6, roughness: 0.7, emissive: new THREE.Color(1.0, 0.9, 0.76), emissiveIntensity: 0.18 }),
    lampWarm: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.8, 0.56).multiplyScalar(2.8) }),
    lampCool: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.78, 0.9, 1.0).multiplyScalar(2.6) }),
    red: new THREE.MeshBasicMaterial({ color: new THREE.Color(4.0, 0.25, 0.12) }),
    sign: new THREE.MeshBasicMaterial({ map: signs.texture, color: new THREE.Color(SIGN_LIFT, SIGN_LIFT, SIGN_LIFT), side: THREE.DoubleSide }),
  };
  for (const [k, m] of Object.entries(M)) if (!m.name) m.name = k;
  const wireMat = new THREE.LineBasicMaterial({ color: 0x15171a, transparent: true, opacity: 0.85, fog: true });
  wireMat.name = 'wires';
  // Wires fade with distance: a pixel-wide line far off is heavier than the wire it stands for.
  wireMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vWD;').replace('#include <fog_vertex>', '#include <fog_vertex>\nvWD = -mvPosition.z;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWD;')
      .replace('#include <opaque_fragment>', `diffuseColor.a *= mix(1.0, 0.28, smoothstep(120.0, ${WIRE_FAR.toFixed(1)}, vWD));\n#include <opaque_fragment>`);
  };
  wireMat.customProgramCacheKey = () => 'palimpsest-transit-wires';
  const noShadow = new Set<THREE.Material>([M.paving, M.tactile, M.lampWarm, M.lampCool, M.red, M.sign, M.paint, M.glassWarm, M.glassCool, M.glassClear, M.ceiling, M.setts, M.deckTop]);

  const group = new THREE.Group();
  group.name = 'transit';
  let parts: TransitChunk[] = [];
  let far: Array<{ mesh: THREE.Mesh | THREE.LineSegments; spans: Array<{ start: number; count: number } | null> }> = [];
  let net: Network | null = null;
  let laid = '';
  let builds = 0;
  let buildMs = 0;
  let counts = { stops: 0, stations: 0, podStations: 0, ranks: 0, poles: 0, bents: 0, pylons: 0 };
  const lodAt = new THREE.Vector3(Infinity, Infinity, Infinity);

  function clear(): void {
    for (const c of parts) {
      for (const tier of [c.core, c.detail]) for (const o of tier.children) (o as THREE.Mesh).geometry.dispose();
      c.wires?.geometry.dispose();
      group.remove(c.group);
    }
    for (const f of far) {
      f.mesh.geometry.dispose();
      group.remove(f.mesh);
    }
    parts = [];
    far = [];
  }

  function build(extent: NetworkExtent): void {
    clear();
    net = network(extent);
    const b = new Build();
    const names = new Set<string>();
    // The atlas is rebuilt with the network: every sign's row is assigned afresh.
    (signs as unknown as { rows: unknown[] }).rows = [];
    const tram = buildTram(b, M, net, signs, names);
    const rail = buildRail(b, M, net, signs, names);
    const pods = buildPods(b, M, net, signs, names);
    for (const r of net.ranks) cabRank(b, M, r, signs.add('Cabs', r.exchange ? 'Exchange' : 'Rank', 'cab'));
    signs.draw();
    // Drawn again once the app's faces have loaded (the first draw may fall back while they arrive).
    void Promise.all([document.fonts?.load('500 52px Newsreader'), document.fonts?.load('400 24px "IBM Plex Mono"')]).then(() => signs.draw(), () => {});
    counts = { stops: tram.stops, stations: rail.stations, podStations: pods.stations, ranks: net.ranks.length, poles: tram.poles, bents: rail.bents, pylons: pods.pylons };
    parts = b.finish((m) => !noShadow.has(m), wireMat);
    for (const c of parts) group.add(c.group);
    far = farCores(parts, wireMat);
    for (const f of far) group.add(f.mesh);
    lodAt.set(Infinity, Infinity, Infinity);
  }

  /** Draws every chunk not near the eye from the far cores, in as few runs as the near chunks leave. */
  function farRuns(near: boolean[]): void {
    for (const f of far) {
      const g = f.mesh.geometry;
      g.clearGroups();
      let start = -1;
      let end = 0;
      const flush = (): void => {
        if (start >= 0) g.addGroup(start, end - start, 0);
        start = -1;
      };
      parts.forEach((_, k) => {
        const sp = f.spans[k];
        if (near[k]) return flush();
        if (!sp) return;
        if (start < 0) start = sp.start;
        else if (sp.start !== end) {
          flush();
          start = sp.start;
        }
        end = sp.start + sp.count;
      });
      flush();
      f.mesh.visible = g.groups.length > 0;
    }
  }

  const frustum = new THREE.Frustum();
  const vp = new THREE.Matrix4();

  return {
    group,
    set(extent) {
      const key = JSON.stringify([extent.blocks, extent.districts.map((d) => [Math.round(d.x), Math.round(d.z)]).sort()]);
      if (key === laid) return false;
      laid = key;
      const t0 = performance.now();
      build(extent);
      builds++;
      buildMs = performance.now() - t0;
      return true;
    },
    update(eye, _fog) {
      if (eye.distanceToSquared(lodAt) < 25) return false;
      lodAt.copy(eye);
      let shadows = false;
      const near = parts.map((c) => chunkDistance(eye, c) < DETAIL_NEAR);
      parts.forEach((c, k) => {
        c.group.visible = near[k];
      });
      farRuns(near);
      for (const c of parts) {
        const d = chunkDistance(eye, c);
        const lod = { detail: d < DETAIL_NEAR, shadow: d < SHADOW_NEAR, ao: d < AO_NEAR };
        if (c.lod && c.lod.detail === lod.detail && c.lod.shadow === lod.shadow && c.lod.ao === lod.ao) continue;
        if (c.lod?.shadow !== lod.shadow) shadows = true;
        c.lod = lod;
        c.detail.visible = lod.detail;
        for (const m of c.casters) m.castShadow = lod.shadow;
        for (const tier of [c.core, c.detail]) for (const o of tier.children) {
          if (lod.ao) o.layers.set(0);
          else setLayers(o, LAYER.view, LAYER.shadow);
        }
        // Wires never cast or join the AO: the view draws them.
        if (c.wires) setLayers(c.wires, LAYER.view);
      }
      return shadows;
    },
    network: () => net,
    view(camera) {
      camera.updateMatrixWorld();
      frustum.setFromProjectionMatrix(vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      let meshes = 0;
      let triangles = 0;
      for (const c of parts) {
        if (!c.group.visible) continue;
        for (const tier of [c.core, c.detail]) {
          if (!tier.visible) continue;
          for (const o of tier.children) {
            const m = o as THREE.Mesh;
            if (!frustum.intersectsObject(m)) continue;
            meshes++;
            triangles += m.geometry.attributes.position.count / 3;
          }
        }
        if (c.wires && frustum.intersectsObject(c.wires)) meshes++;
      }
      for (const f of far) {
        if (!f.mesh.visible) continue;
        for (const gr of f.mesh.geometry.groups) {
          meshes++;
          if ((f.mesh as THREE.Mesh).isMesh) triangles += gr.count / 3;
        }
      }
      return { meshes, triangles, ...counts, blocks: net?.blocks ?? 0, builds, buildMs };
    },
    dispose() {
      clear();
      for (const m of Object.values(M)) if (m !== L.darkMetal) m.dispose();
      wireMat.dispose();
      setts.dispose();
      signs.texture.dispose();
    },
  };
}

/** One merged mesh per material (and one for the wires) across every chunk, in chunk order, with each chunk's span. */
function farCores(parts: TransitChunk[], wireMat: THREE.LineBasicMaterial): Array<{ mesh: THREE.Mesh | THREE.LineSegments; spans: Array<{ start: number; count: number } | null> }> {
  const mats = new Set<THREE.Material>();
  for (const c of parts) for (const m of c.coreGeos.keys()) mats.add(m);
  const out: Array<{ mesh: THREE.Mesh | THREE.LineSegments; spans: Array<{ start: number; count: number } | null> }> = [];
  const merge = (get: (c: TransitChunk) => THREE.BufferGeometry | undefined): { geo: THREE.BufferGeometry; spans: Array<{ start: number; count: number } | null> } | null => {
    const list: THREE.BufferGeometry[] = [];
    const spans: Array<{ start: number; count: number } | null> = [];
    let at = 0;
    for (const c of parts) {
      const g = get(c);
      if (!g) {
        spans.push(null);
        continue;
      }
      const n = g.attributes.position.count;
      spans.push({ start: at, count: n });
      at += n;
      list.push(g);
    }
    const geo = list.length ? mergeGeometries(list, false) : null;
    if (!geo) return null;
    geo.computeBoundingSphere();
    return { geo, spans };
  };
  for (const mat of mats) {
    const m = merge((c) => c.coreGeos.get(mat));
    if (!m) continue;
    const mesh = new THREE.Mesh(m.geo, [mat]);
    mesh.name = `transit-far:${mat.name || mat.type}`;
    mesh.receiveShadow = true;
    // Far off it neither casts nor joins the AO: the view draws it alone.
    setLayers(mesh, LAYER.view);
    out.push({ mesh, spans: m.spans });
  }
  const w = merge((c) => c.wires?.geometry);
  if (w) {
    const lines = new THREE.LineSegments(w.geo, [wireMat] as unknown as THREE.LineBasicMaterial);
    lines.name = 'transit-far:wires';
    setLayers(lines, LAYER.view);
    out.push({ mesh: lines, spans: w.spans });
  }
  return out;
}
