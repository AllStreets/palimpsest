/**
 * The river (ruling 14): a straight channel 56 m wide down the street line at
 * x = -360, cut into the ground between coursed stone quay walls with granite
 * copings and parapets, mooring rings and river stairs; three bridges modelled
 * in their own engineering languages (a three-span stone arch on the civic
 * axis, a steel tied through-arch and a cable-stayed deck hung from one
 * pylon), each with its lamps; ferry piers with a floating landing stage, a
 * shelter and a lit name sign; and the water itself.
 *
 * Every static part is merged into one mesh per material across the whole
 * river (a dozen draw calls). The water is drawn after the scene, in its own
 * post pass, so it can reflect the frame it lies in: a screen-space march
 * over the scene's depth finds the towers, the bridges, the quay walls and
 * every lit window and lamp above it; what the frame does not hold (rays
 * leaving the screen) reflects the same analytic dusk sky the dome draws.
 * Fresnel weights the reflection over a dark river body, slow ripple normals
 * break it into streaks, the afterglow lays its path down the water, and the
 * water darkens in the walls' shadow. Geometry is own work (CREDITS.md); the
 * stone and granite are the Poly Haven scans already in the city.
 */
import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { BANKS, BRIDGE_DECK, BRIDGES, PIER_HALF, PIERS, QUAY, RIVER, type Pier } from '../../../shared/commute.js';
import { LAYER, setLayers } from './lod.js';
import { materials, texture } from './materials';
import { chunkAt, chunkLod, chunks, waterSettings, type Chunk } from './river-lod.js';
import { SKY_GLSL, SUN_DIRECTION } from './sky';

/** The water's surface, metres below the quays. */
export const WATER_Y = -6.2;
/** The most boats whose wakes the water draws. */
const WAKES = 4;
/** The quay walls stand on footings this deep (hidden under the water). */
const WALL_FOOT = -9;
/** The river runs the length of the ground. */
const LENGTH = 16000;
/** The parapet along each quay, on the coping. */
const PARAPET_H = 0.95;
const PARAPET_W = 0.55;
/** The granite coping along each quay's edge, from the wall's face inland: the ground stops where it starts. */
export const COPING = 2.4;
/** Quay lamps stand this far back from the wall's face, one every QUAY_LAMP_STEP metres. */
export const QUAY_LAMP_IN = 3.2;
export const QUAY_LAMP_STEP = 30;
/** Quay lamps run this far up and down the river: the length of the detailed city. */
export const QUAY_LAMP_REACH = 1800;
/** No quay lamp stands within this of a bridge's centre line or a pier's stair. */
export const QUAY_LAMP_CLEAR = 18;
/** The deck's top: a hair above the street, so the road runs on without a step. */
const DECK_TOP = 0.08;
/** Lamp light, as HDR colour: warm metal halide on the quays and bridges, a little whiter than the sodium streets. */
const LANTERN = new THREE.Color(1.0, 0.74, 0.46).multiplyScalar(2.8);

export type BridgeKind = 'arch' | 'stone' | 'stayed';
/** Which bridge stands where (z): the steel tied arch upstream, the stone arch on the civic axis, the cable-stayed deck downstream. */
export const BRIDGE_KINDS: Record<number, BridgeKind> = { [BRIDGES[0]]: 'arch', [BRIDGES[1]]: 'stone', [BRIDGES[2]]: 'stayed' };

/** The names on the piers' signs, in PIERS order. Places of the city, not of anyone's data. */
export const PIER_NAMES = ['Tannery Wharf', 'Ropewalk Stairs', 'Ironworks Pier', 'Lock Street', 'Chandlers Quay', 'Mill Stairs', 'Gasholder Pier', 'Exchange Stairs'];

/** Where each quay lamp stands. */
export function quayLamps(): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  for (const bank of ['west', 'east'] as const) {
    const x = bank === 'west' ? BANKS.west - QUAY_LAMP_IN : BANKS.east + QUAY_LAMP_IN;
    for (let z = -QUAY_LAMP_REACH; z <= QUAY_LAMP_REACH; z += QUAY_LAMP_STEP) {
      if (quayLampClear(bank, z)) out.push({ x, z });
    }
  }
  return out;
}

/** True when a quay lamp may stand at z on this bank: clear of the bridges and of the piers' stairs on that bank. */
export function quayLampClear(bank: 'west' | 'east', z: number): boolean {
  if (BRIDGES.some((b) => Math.abs(z - b) < QUAY_LAMP_CLEAR)) return false;
  return !PIERS.some((p) => p.bank === bank && Math.abs(z - p.z) < QUAY_LAMP_CLEAR);
}

// ---------------------------------------------------------------- materials

/**
 * A scanned material laid on by world position (triplanar, courses level on
 * every face whatever the geometry's own UVs), with the river's mark on it:
 * stone below the high-water line wet, dark and glossy, a green-black film
 * of weed at the waterline, and streaks of run-off staining down from it.
 */
function riverStone(prefix: string, tile: number, colour: number, key: string, normalScale = 1, course?: { h: number; l: number }): THREE.MeshStandardMaterial {
  const tAlb = texture(`${prefix}_diff.jpg`, true);
  const tNor = texture(`${prefix}_nor.jpg`);
  const tArm = texture(`${prefix}_arm.jpg`);
  const m = new THREE.MeshStandardMaterial({ color: colour, roughness: 1, metalness: 0 });
  m.customProgramCacheKey = () => `palimpsest-river-${key}`;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { tAlb: { value: tAlb }, tNor: { value: tNor }, tArm: { value: tArm } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTP; varying vec3 vTN;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vTP; varying vec3 vTN;
        uniform sampler2D tAlb; uniform sampler2D tNor; uniform sampler2D tArm;
        const float TILE = ${tile.toFixed(2)};
        const float WATER = ${WATER_Y.toFixed(2)};
        const float COURSE_H = ${(course?.h ?? 0).toFixed(3)};
        const float COURSE_L = ${(course?.l ?? 1).toFixed(3)};
        float rsHash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
        float rsNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
          return mix(mix(rsHash(i), rsHash(i+vec2(1,0)), f.x), mix(rsHash(i+vec2(0,1)), rsHash(i+vec2(1,1)), f.x), f.y); }
        vec3 triW() { vec3 b = pow(abs(normalize(vTN)), vec3(4.0)); return b / dot(b, vec3(1.0)); }
        vec4 tri(sampler2D t, vec3 b) {
          return texture2D(t, vTP.zy / TILE) * b.x + texture2D(t, vTP.xz / TILE) * b.y + texture2D(t, vTP.xy / TILE) * b.z;
        }
        // How wet the stone is: soaked below the high-water line, drying in streaks above it.
        float rsWet() {
          float along = vTP.x + vTP.z;
          float streak = rsNoise(vec2(along * 1.7, 0.0)) * 0.9 + rsNoise(vec2(along * 6.0, 3.0)) * 0.5;
          return 1.0 - smoothstep(WATER + 0.8, WATER + 1.3 + streak * 1.0, vTP.y);
        }`,
      )
      .replace(
        '#include <map_fragment>',
        `vec3 tb = triW();
        vec4 alb = tri(tAlb, tb);
        vec4 armT = tri(tArm, tb);
        vec2 jointTilt = vec2(0.0);
        if (COURSE_H > 0.0) {
          // Coursed ashlar: level courses, blocks of varied length broken joint to joint, each its own tone, sunk
          // mortar joints. The scan gives only the stone's grain (its own slab joints are washed out).
          vec3 an = abs(normalize(vTN));
          float vert = 1.0 - smoothstep(0.6, 0.85, an.y);
          float u = an.x > an.z ? vTP.z : vTP.x;
          float row = floor(vTP.y / COURSE_H);
          float len = COURSE_L * (0.75 + 0.5 * rsHash(vec2(row, 3.7)));
          float uu = u / len + 0.5 * mod(row, 2.0) + rsHash(vec2(row, 9.1));
          float col = floor(uu);
          vec2 f = vec2(fract(uu) * len, fract(vTP.y / COURSE_H) * COURSE_H);
          float jd = min(min(f.x, len - f.x), min(f.y, COURSE_H - f.y));
          float joint = (1.0 - smoothstep(0.008, 0.028, jd)) * vert;
          float tone = 0.8 + 0.34 * rsHash(vec2(col, row)) + 0.08 * (rsNoise(vec2(u, vTP.y) * 1.3) - 0.5);
          vec3 grain = mix(vec3(0.62), alb.rgb, 0.4) / 0.62;
          diffuseColor.rgb *= mix(alb.rgb, grain * mix(1.0, tone, vert), vert) * mix(1.0, 0.42, joint);
          // Arrises worn into the joints: the face tilts toward each joint in its last few centimetres.
          float ex = 1.0 - smoothstep(0.0, 0.05, min(f.x, len - f.x));
          float ey = 1.0 - smoothstep(0.0, 0.05, min(f.y, COURSE_H - f.y));
          jointTilt = vec2(ex * sign(f.x - len * 0.5), ey * sign(f.y - COURSE_H * 0.5)) * 0.5 * vert;
        } else {
          diffuseColor.rgb *= alb.rgb * mix(1.0, armT.r, 0.6);
        }
        float wet = rsWet();
        float weed = 1.0 - smoothstep(WATER + 0.25, WATER + 0.85 + rsNoise(vec2(vTP.x + vTP.z, 0.0) * 0.9) * 0.4, vTP.y);
        diffuseColor.rgb *= mix(1.0, 0.36, wet);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.025, 0.032, 0.02), weed * 0.85);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = roughness * armT.g;
        roughnessFactor = mix(roughnessFactor, 0.28, wet);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `{
          vec3 N = normalize(vTN);
          vec3 tX = texture2D(tNor, vTP.zy / TILE).xyz * 2.0 - 1.0;
          vec3 tY = texture2D(tNor, vTP.xz / TILE).xyz * 2.0 - 1.0;
          vec3 tZ = texture2D(tNor, vTP.xy / TILE).xyz * 2.0 - 1.0;
          float ns = ${normalScale.toFixed(2)};
          vec3 nX = vec3(tX.xy * ns + N.zy, N.x);
          vec3 nY = vec3(tY.xy * ns + N.xz, N.y);
          vec3 nZ = vec3(tZ.xy * ns + N.xy, N.z);
          vec3 wn = normalize(nX.zyx * tb.x + nY.xzy * tb.y + nZ.xyz * tb.z);
          vec3 an2 = abs(N);
          vec3 tU = an2.x > an2.z ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
          wn = normalize(wn + tU * jointTilt.x + vec3(0.0, 1.0, 0.0) * jointTilt.y);
          normal = normalize((viewMatrix * vec4(wn, 0.0)).xyz);
        }`,
      );
  };
  return m;
}

/**
 * Pools of lamp light on a deck, a pontoon or a footway: albedo-weighted
 * irradiance as the ground's street pools are, from each lamp in the list.
 */
function pooled(m: THREE.MeshStandardMaterial, key: string, lamps: THREE.Vector4[]): THREE.MeshStandardMaterial {
  const n = Math.max(1, lamps.length);
  const list = lamps.length ? lamps : [new THREE.Vector4(1e6, 0, 1e6, 0)];
  m.customProgramCacheKey = () => `palimpsest-river-pool-${key}-${n}`;
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uLamps = { value: list };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvPW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vPW;\nuniform vec4 uLamps[${n}];`)
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        {
          float light = 0.0;
          for (int i = 0; i < ${n}; i++) {
            vec4 l = uLamps[i];
            vec3 d = vPW - l.xyz;
            float dd = dot(d.xz, d.xz);
            // Inverse square from the lantern's height, cosine to the deck, softened at the foot.
            light += l.w * l.y * l.y / pow(dd + l.y * l.y, 1.5) * 1.0;
          }
          totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.72, 0.45) * light * 9.0;
        }`,
      );
  };
  return m;
}

/** A surface lit from its own foot by floodlights: a pylon, an arch rib. Brightest at the base, falling off with height. */
function uplit(m: THREE.MeshStandardMaterial, key: string, base: number, reach: number, strength: number, tint: THREE.Color): THREE.MeshStandardMaterial {
  m.customProgramCacheKey = () => `palimpsest-river-uplit-${key}`;
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vUP; varying vec3 vUN;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvUP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvUN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vUP; varying vec3 vUN;').replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
      {
        float h = max(vUP.y - ${base.toFixed(2)}, 0.0);
        float side = 1.0 - abs(vUN.y);
        float wash = side * exp(-h / ${reach.toFixed(2)}) + max(-vUN.y, 0.0) * 0.6 * exp(-h / ${(reach * 2).toFixed(2)});
        totalEmissiveRadiance += diffuseColor.rgb * vec3(${tint.r.toFixed(3)}, ${tint.g.toFixed(3)}, ${tint.b.toFixed(3)}) * wash * ${strength.toFixed(3)};
      }`,
    );
  };
  return m;
}

interface RiverMaterials {
  wall: THREE.MeshStandardMaterial;
  granite: THREE.MeshStandardMaterial;
  bridgeStone: THREE.MeshStandardMaterial;
  balustrade: THREE.MeshStandardMaterial;
  iron: THREE.MeshStandardMaterial;
  steel: THREE.MeshStandardMaterial;
  concrete: THREE.MeshStandardMaterial;
  cable: THREE.MeshStandardMaterial;
  deck: THREE.MeshStandardMaterial;
  footway: THREE.MeshStandardMaterial;
  hull: THREE.MeshStandardMaterial;
  timber: THREE.MeshStandardMaterial;
  glass: THREE.MeshPhysicalMaterial;
  lantern: THREE.MeshBasicMaterial;
  lampHead: THREE.MeshBasicMaterial;
  red: THREE.MeshBasicMaterial;
  sign: THREE.MeshBasicMaterial;
}

// ---------------------------------------------------------------- building

type V3 = [number, number, number];

/**
 * Geometry gathered in world space by chunk (river-lod.ts), by tier (the
 * core, drawn at any distance, or the detail, drawn only near) and by
 * material, merged into one mesh per material in each chunk and tier.
 */
class Build {
  private by = new Map<string, Map<THREE.Material, THREE.BufferGeometry[]>>();
  /** The tier the next parts go into. */
  tier: 'core' | 'detail' = 'core';
  /** Adds the parts `fn` builds to the detail tier. */
  detail(fn: () => void): void {
    const was = this.tier;
    this.tier = 'detail';
    fn();
    this.tier = was;
  }
  /** Adds a geometry, transformed by `m` when given. */
  add(mat: THREE.Material, g: THREE.BufferGeometry, m?: THREE.Matrix4): void {
    let geo = g.index ? g.toNonIndexed() : g.clone();
    if (m) geo.applyMatrix4(m);
    for (const name of Object.keys(geo.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv') geo.deleteAttribute(name);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    geo = geo.index ? geo.toNonIndexed() : geo;
    geo.computeBoundingBox();
    const zc = (geo.boundingBox!.min.z + geo.boundingBox!.max.z) / 2;
    const key = `${chunkAt(zc)}|${this.tier}`;
    let mats = this.by.get(key);
    if (!mats) this.by.set(key, (mats = new Map()));
    const list = mats.get(mat) ?? [];
    list.push(geo);
    mats.set(mat, list);
  }
  /** A box centred at (x, y, z), turned ry about the vertical. */
  box(mat: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0): void {
    this.add(mat, UNIT_BOX, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(Y, ry), new THREE.Vector3(sx, sy, sz)));
  }
  /** A box from a to b (its long axis), w by h in section; `up` fixes its roll. */
  beam(mat: THREE.Material, a: V3, b: V3, w: number, h: number, up: V3 = [0, 1, 0]): void {
    const A = new THREE.Vector3(...a);
    const B = new THREE.Vector3(...b);
    const len = A.distanceTo(B);
    const xAxis = B.clone().sub(A).normalize();
    let zAxis = new THREE.Vector3().crossVectors(xAxis, new THREE.Vector3(...up));
    if (zAxis.lengthSq() < 1e-6) zAxis = new THREE.Vector3().crossVectors(xAxis, new THREE.Vector3(1, 0, 0));
    zAxis.normalize();
    const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis);
    const m = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis).scale(new THREE.Vector3(len, h, w));
    m.setPosition(A.clone().add(B).multiplyScalar(0.5));
    this.add(mat, UNIT_BOX, m);
  }
  /** A round bar from a to b. */
  rod(mat: THREE.Material, a: V3, b: V3, r: number, seg = 6): void {
    const A = new THREE.Vector3(...a);
    const B = new THREE.Vector3(...b);
    const len = A.distanceTo(B);
    const q = new THREE.Quaternion().setFromUnitVectors(Y, B.clone().sub(A).normalize());
    this.add(mat, cylinder(seg), new THREE.Matrix4().compose(A.clone().add(B).multiplyScalar(0.5), q, new THREE.Vector3(r, len, r)));
  }
  /** A geometry placed at (x, y, z), turned ry, scaled s. */
  put(mat: THREE.Material, g: THREE.BufferGeometry, x: number, y: number, z: number, ry = 0, s: V3 = [1, 1, 1]): void {
    this.add(mat, g, new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(Y, ry), new THREE.Vector3(...s)));
  }
  /** One group per chunk that holds anything, with its core and detail meshes. */
  chunks(shadows: (m: THREE.Material) => boolean): RiverChunk[] {
    const all = chunks();
    const out = new Map<number, RiverChunk>();
    for (const [key, mats] of this.by) {
      const [ci, tier] = key.split('|') as [string, 'core' | 'detail'];
      const index = Number(ci);
      let rc = out.get(index);
      if (!rc) {
        const group = new THREE.Group();
        group.name = `river-chunk-${index}`;
        const core = new THREE.Group();
        const detail = new THREE.Group();
        group.add(core, detail);
        out.set(index, (rc = { chunk: all[index], group, core, detail, casters: [], coreGeos: new Map(), triangles: { core: 0, detail: 0 }, lod: null }));
      }
      for (const [mat, list] of mats) {
        const geo = mergeGeometries(list, false);
        for (const g of list) g.dispose();
        if (!geo) continue;
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.castShadow = mesh.receiveShadow = shadows(mat);
        if (mesh.castShadow) rc.casters.push(mesh);
        mesh.name = `river:${mat.name || mat.type}`;
        (tier === 'core' ? rc.core : rc.detail).add(mesh);
        if (tier === 'core') rc.coreGeos.set(mat, geo);
        rc.triangles[tier] += geo.attributes.position.count / 3;
      }
    }
    this.by.clear();
    return [...out.values()].sort((a, b) => a.chunk.z0 - b.chunk.z0);
  }
}

/** A chunk of the river as built: its core and detail meshes, the meshes that cast shadows, its triangles per tier. */
interface RiverChunk {
  chunk: Chunk;
  group: THREE.Group;
  core: THREE.Group;
  detail: THREE.Group;
  casters: THREE.Mesh[];
  /** The chunk's core, merged, by material (the far core copies it). */
  coreGeos: Map<THREE.Material, THREE.BufferGeometry>;
  triangles: { core: number; detail: number };
  lod: { detail: boolean; shadow: boolean; ao: boolean } | null;
}

/**
 * The far core: every chunk's core merged into one mesh per material, in
 * chunk order, with each chunk's span. Chunks past the detail distance draw
 * from it in at most two runs per material (those before the near chunks and
 * those after), so the river far off costs a few calls, not one per material
 * per chunk; the near chunks draw their own meshes and the frustum culls them.
 */
interface FarCore {
  mesh: THREE.Mesh;
  /** Each chunk's first vertex and vertex count in the merged mesh, by its index in the sorted chunks (absent: none). */
  spans: Array<{ start: number; count: number } | null>;
}

function farCores(parts: RiverChunk[]): FarCore[] {
  const mats = new Set<THREE.Material>();
  for (const c of parts) for (const m of c.coreGeos.keys()) mats.add(m);
  const out: FarCore[] = [];
  for (const mat of mats) {
    const list: THREE.BufferGeometry[] = [];
    const spans: FarCore['spans'] = [];
    let at = 0;
    for (const c of parts) {
      const g = c.coreGeos.get(mat);
      if (!g) {
        spans.push(null);
        continue;
      }
      const n = g.attributes.position.count;
      spans.push({ start: at, count: n });
      at += n;
      list.push(g);
    }
    const geo = mergeGeometries(list, false);
    if (!geo) continue;
    geo.computeBoundingSphere();
    // One material slot, drawn in the runs set as groups (river update).
    const mesh = new THREE.Mesh(geo, [mat]);
    mesh.name = `river-far:${mat.name || mat.type}`;
    mesh.receiveShadow = true;
    // Far off it neither casts (river-lod.ts SHADOW_NEAR) nor joins the AO (AO_NEAR): the view draws it alone.
    setLayers(mesh, LAYER.view);
    out.push({ mesh, spans });
  }
  return out;
}

const Y = new THREE.Vector3(0, 1, 0);
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const CYLS = new Map<number, THREE.BufferGeometry>();
function cylinder(seg: number): THREE.BufferGeometry {
  let g = CYLS.get(seg);
  if (!g) CYLS.set(seg, (g = new THREE.CylinderGeometry(1, 1, 1, seg, 1)));
  return g;
}

/** A lathe from a profile of [radius, height] pairs. */
function lathe(profile: Array<[number, number]>, seg = 12): THREE.BufferGeometry {
  return new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    seg,
  );
}

// ---------------------------------------------------------------- lamps

/**
 * The quay lamp standard: a cast-iron column on a moulded base, a collar and
 * a swan-neck bracket would be the Paris model; this one is plainer, a fluted
 * shaft with a bell capital carrying a four-sided lantern under a ventilated
 * crown and a finial. 5.6 m to the finial. Returns the lantern's centre height.
 */
function quayLamp(b: Build, M: RiverMaterials, x: number, z: number, lamps: THREE.Vector4[]): void {
  b.put(M.lantern, LAMP_GLASS, x, 4.62, z, Math.PI / 4);
  b.detail(() => {
    b.put(M.iron, LAMP_BASE, x, 0, z);
    b.put(M.iron, LAMP_SHAFT, x, 0, z);
    b.put(M.iron, LAMP_CROWN, x, 5.02, z, Math.PI / 4);
    // The lantern's four corner bars.
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2;
      b.rod(M.iron, [x + Math.cos(a) * 0.2, 4.28, z + Math.sin(a) * 0.2], [x + Math.cos(a) * 0.27, 4.98, z + Math.sin(a) * 0.27], 0.022, 4);
    }
  });
  lamps.push(new THREE.Vector4(x, 4.62, z, 1));
}

const LAMP_BASE = lathe([[0, 0], [0.3, 0], [0.3, 0.12], [0.24, 0.18], [0.22, 0.62], [0.17, 0.7], [0.14, 0.78], [0, 0.78]], 8);
const LAMP_SHAFT = lathe([[0, 0.7], [0.11, 0.7], [0.085, 3.6], [0.11, 3.66], [0.11, 3.74], [0.08, 3.8], [0.2, 4.2], [0.21, 4.28], [0, 4.28]], 10);
const LAMP_GLASS = new THREE.CylinderGeometry(0.27, 0.2, 0.68, 4, 1);
const LAMP_CROWN = lathe([[0, 0], [0.36, 0], [0.33, 0.06], [0.08, 0.32], [0.05, 0.4], [0.07, 0.46], [0.02, 0.62], [0, 0.62]], 4);

/** The stone bridge's candelabrum: a cast-iron column on a stone pedestal, three lanterns on a crossbar and the column's head. */
function candelabrum(b: Build, M: RiverMaterials, x: number, y: number, z: number, along: number, lamps: THREE.Vector4[]): void {
  // The ironwork and pedestal are near detail; the lanterns' glass is core, so the lamps read from afar.
  const was = b.tier;
  b.tier = 'detail';
  b.box(M.balustrade, x, y + 0.7, z, 1.2, 1.4, 1.2);
  b.box(M.balustrade, x, y + 1.46, z, 1.36, 0.12, 1.36);
  b.put(M.iron, LAMP_BASE, x, y + 1.52, z, 0, [1.3, 1.1, 1.3]);
  b.put(M.iron, CANDLE_SHAFT, x, y + 1.52, z);
  const top = y + 1.52 + 5.0;
  // The crossbar runs along the parapet, a lantern hung over each end.
  const ax = Math.cos(along);
  const az = Math.sin(along);
  b.beam(M.iron, [x - ax * 0.95, top - 0.4, z - az * 0.95], [x + ax * 0.95, top - 0.4, z + az * 0.95], 0.09, 0.12);
  for (const s of [-1, 1, 0]) {
    const lx = x + ax * 0.95 * s;
    const lz = z + az * 0.95 * s;
    const ly = s === 0 ? top + 0.55 : top - 0.08;
    b.tier = 'core';
    b.put(M.lantern, LAMP_GLASS, lx, ly, lz, Math.PI / 4, [1.1, 1.1, 1.1]);
    b.tier = 'detail';
    b.put(M.iron, LAMP_CROWN, lx, ly + 0.42, lz, Math.PI / 4, [1.1, 1.0, 1.1]);
    lamps.push(new THREE.Vector4(lx, ly, lz, 1.1));
  }
  b.tier = was;
}
const CANDLE_SHAFT = lathe([[0, 0.7], [0.14, 0.7], [0.1, 2.0], [0.13, 2.08], [0.09, 2.2], [0.07, 4.6], [0.12, 4.68], [0.12, 4.78], [0.06, 4.86], [0.06, 5.5], [0, 5.5]], 10);

// ---------------------------------------------------------------- the quays

/** The quay walls, copings, parapets, mooring rings, drains and lamps along both banks. */
function buildQuays(b: Build, M: RiverMaterials, lamps: THREE.Vector4[]): void {
  for (const bank of ['west', 'east'] as const) {
    const s = bank === 'west' ? -1 : 1; // outward from the river
    const face = BANKS[bank];
    // Parapet runs, broken at each bridge and each pier's stair.
    const gaps: Array<[number, number]> = [];
    for (const bz of BRIDGES) gaps.push([bz - BRIDGE_DECK / 2 - 0.6, bz + BRIDGE_DECK / 2 + 0.6]);
    for (const p of PIERS) if (p.bank === bank) gaps.push([p.z - 1.6, p.z + 1.6]);
    gaps.sort((a, c) => a[0] - c[0]);
    const px = face + s * (PARAPET_W / 2 + 0.05);
    // Everything that runs the river's length is laid chunk by chunk (river-lod.ts), so the frustum culls it.
    for (const { z0, z1 } of chunks()) {
      // The wall: 3 m of masonry behind its face, its face slightly battered (it leans back 1 in 30).
      const top = -0.62;
      const lean = (top - WALL_FOOT) / 30;
      const shape = new THREE.Shape([new THREE.Vector2(face, WALL_FOOT), new THREE.Vector2(face + s * 3, WALL_FOOT), new THREE.Vector2(face + s * 3, top), new THREE.Vector2(face + s * lean, top)]);
      const wall = new THREE.ExtrudeGeometry(shape, { depth: z1 - z0, bevelEnabled: false });
      wall.translate(0, 0, z0);
      b.add(M.wall, wall);
      wall.dispose();
      const zc = (z0 + z1) / 2;
      // The granite string course and coping at the wall head, oversailing the face.
      b.box(M.granite, face + (s * (COPING - 0.22)) / 2, -0.31, zc, COPING + 0.22, 0.62, z1 - z0);
      b.box(M.granite, face - s * 0.12, -0.7, zc, 0.5, 0.16, z1 - z0);
      // The parapet with its rounded coping, clipped to this chunk.
      let from = z0;
      const runs: Array<[number, number]> = [];
      for (const [g0, g1] of [...gaps.filter(([g0, g1]) => g1 > z0 && g0 < z1), [z1, z1] as [number, number]]) {
        if (Math.min(g0, z1) > from) runs.push([from, Math.min(g0, z1)]);
        from = Math.max(from, g1);
      }
      for (const [r0, r1] of runs) {
        const len = r1 - r0;
        const rc = (r0 + r1) / 2;
        b.box(M.granite, px, PARAPET_H / 2 - 0.02, rc, PARAPET_W, PARAPET_H, len);
        b.put(M.granite, PARAPET_CAP, px, PARAPET_H - 0.02, rc, 0, [1, 1, len]);
        // Piers in the parapet every 15 m, a course proud: near detail.
        b.detail(() => {
          for (let z = Math.ceil(r0 / 15) * 15; z < r1 - 1; z += 15) if (z > r0 + 1) b.box(M.granite, px, PARAPET_H / 2 + 0.04, z, PARAPET_W + 0.12, PARAPET_H + 0.12, 0.9);
        });
      }
    }
    b.detail(() => {
      // Mooring rings on the wall face a metre and a half above the water, every 18 m, on their plates.
      for (let z = -QUAY_LAMP_REACH; z <= QUAY_LAMP_REACH; z += 18) {
        if (BRIDGES.some((bz) => Math.abs(z - bz) < 16)) continue;
        const y = WATER_Y + 1.6;
        b.box(M.iron, face - s * 0.04, y + 0.18, z, 0.06, 0.34, 0.26);
        b.put(M.iron, RING, face - s * 0.12, y, z, 0);
      }
      // Storm outfalls every 240 m: a dark arched mouth with a stone ring of voussoirs.
      for (let z = -1680; z <= 1680; z += 240) {
        if (BRIDGES.some((bz) => Math.abs(z - bz) < 40) || PIERS.some((p) => Math.abs(z - p.z) < 30)) continue;
        const zc = z + 120;
        const yc = WATER_Y + 1.1;
        b.box(M.hull, face - s * 0.02, yc - 0.3, zc, 0.06, 1.4, 1.8);
        for (let k = 0; k <= 8; k++) {
          const a = (k / 8) * Math.PI;
          b.box(M.granite, face - s * 0.06, yc + 0.4 + Math.sin(a) * 1.05, zc + Math.cos(a) * 1.05, 0.14, 0.42, 0.34, 0);
        }
      }
    });
    // Lamps on the promenade, a step back from the parapet: the glass is core (the lamp lines read from afar), the ironwork detail.
    for (let z = -QUAY_LAMP_REACH; z <= QUAY_LAMP_REACH; z += QUAY_LAMP_STEP) {
      if (!quayLampClear(bank, z)) continue;
      quayLamp(b, M, face + s * QUAY_LAMP_IN, z, lamps);
    }
  }
}

const RING = new THREE.TorusGeometry(0.2, 0.035, 6, 14).rotateY(Math.PI / 2);
/** A half-round coping laid along z, its flat on the parapet. */
const PARAPET_CAP = (() => {
  const g = new THREE.CylinderGeometry(0.33, 0.33, 1, 12, 1, false, 0, Math.PI);
  g.rotateX(Math.PI / 2);
  g.rotateZ(Math.PI / 2);
  g.scale(1, 0.45, 1);
  return g;
})();

// ---------------------------------------------------------------- the stone bridge

/** A segmental arch: its centre, radius and the angles of its springings, for a span from x0 to x1 springing at ys with rise h. */
function segment(x0: number, x1: number, ys: number, h: number): { cx: number; cy: number; r: number; a0: number; a1: number } {
  const half = (x1 - x0) / 2;
  const r = (half * half + h * h) / (2 * h);
  const cx = (x0 + x1) / 2;
  const cy = ys + h - r;
  const a = Math.asin(half / r);
  return { cx, cy, r, a0: Math.PI / 2 + a, a1: Math.PI / 2 - a };
}

/**
 * The stone bridge on the civic axis: three segmental arches (16, 18 and 16
 * m) on two river piers with pointed cutwaters, the spandrels in coursed
 * stone, each arch ring of voussoirs proud of the face with a keystone, a
 * granite cornice, a balustrade on a plinth with pedestals over the piers
 * and a cast-iron candelabrum on each pedestal and at each end.
 */
function stoneBridge(b: Build, M: RiverMaterials, bz: number, lamps: THREE.Vector4[], deckLamps: THREE.Vector4[]): void {
  const x0 = BANKS.west - 4;
  const x1 = BANKS.east + 4;
  const half = BRIDGE_DECK / 2;
  const spring = WATER_Y + 1.3;
  const piers = [RIVER.x - 10.5, RIVER.x + 10.5];
  const pw = 3;
  const spans: Array<[number, number, number]> = [
    [BANKS.west, piers[0] - pw / 2, 3.3],
    [piers[0] + pw / 2, piers[1] - pw / 2, 3.8],
    [piers[1] + pw / 2, BANKS.east, 3.3],
  ];
  const top = -0.55;
  const shape = new THREE.Shape([new THREE.Vector2(x0, WALL_FOOT), new THREE.Vector2(x1, WALL_FOOT), new THREE.Vector2(x1, top), new THREE.Vector2(x0, top)]);
  for (const [a, c, h] of spans) {
    const s = segment(a, c, spring, h);
    const pts: THREE.Vector2[] = [new THREE.Vector2(a, WALL_FOOT + 0.5)];
    const n = 28;
    for (let k = 0; k <= n; k++) {
      const t = s.a0 + (s.a1 - s.a0) * (k / n);
      pts.push(new THREE.Vector2(s.cx + Math.cos(t) * s.r, s.cy + Math.sin(t) * s.r));
    }
    pts.push(new THREE.Vector2(c, WALL_FOOT + 0.5));
    shape.holes.push(new THREE.Path(pts.reverse()));
  }
  const body = new THREE.ExtrudeGeometry(shape, { depth: BRIDGE_DECK, bevelEnabled: false, curveSegments: 1 });
  body.translate(0, 0, bz - half);
  b.add(M.bridgeStone, body);
  body.dispose();

  // Arch rings: voussoirs proud of each face, alternating long and short, a keystone at the crown (near detail).
  b.tier = 'detail';
  for (const [a, c, h] of spans) {
    const s = segment(a, c, spring, h);
    const n = 23;
    for (const face of [-1, 1]) {
      const fz = bz + face * (half + 0.06);
      for (let k = 0; k < n; k++) {
        const t = s.a0 + (s.a1 - s.a0) * ((k + 0.5) / n);
        const key = k === Math.floor(n / 2);
        const depth = key ? 1.45 : k % 2 ? 0.95 : 1.15;
        const rm = s.r + depth / 2;
        const arc = ((s.a0 - s.a1) * s.r) / n;
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), t - Math.PI / 2);
        b.add(M.balustrade, UNIT_BOX, new THREE.Matrix4().compose(new THREE.Vector3(s.cx + Math.cos(t) * rm, s.cy + Math.sin(t) * rm, fz + face * (key ? 0.08 : 0)), q, new THREE.Vector3(arc - 0.05, depth, key ? 0.3 : 0.14)));
      }
    }
  }

  b.tier = 'core';
  // Cutwaters: pointed noses up and downstream of each pier, capped with a stepped stone hood, and a pilaster above.
  for (const px of piers) {
    for (const face of [-1, 1]) {
      const nose = new THREE.Shape([new THREE.Vector2(-pw / 2 - 0.2, 0), new THREE.Vector2(pw / 2 + 0.2, 0), new THREE.Vector2(0, 2.6)]);
      const ng = new THREE.ExtrudeGeometry(nose, { depth: spring + 1.7 - WALL_FOOT, bevelEnabled: false });
      // Extruded along +z: stand it up, nose pointing away from the deck.
      ng.rotateX(-Math.PI / 2);
      if (face > 0) ng.rotateY(Math.PI);
      ng.translate(px, WALL_FOOT, bz + face * half);
      b.add(M.bridgeStone, ng);
      ng.dispose();
      // The hood: a pyramid cap sloping back to the face.
      b.add(M.balustrade, hoodGeometry(px, spring + 1.7, bz + face * half, face, pw / 2 + 0.2, 2.6, 1.5));
      // A pilaster rising from the hood to the cornice, carrying the refuge above.
      b.box(M.bridgeStone, px, (spring + 3.0 + top) / 2, bz + face * (half + 0.22), pw + 0.4, top - spring - 3.0, 0.44);
    }
  }

  // The cornice: a granite band along each face at the deck's edge, with a dentil course under it.
  for (const face of [-1, 1]) {
    const fz = bz + face * (half + 0.18);
    b.box(M.granite, (x0 + x1) / 2, -0.32, fz, x1 - x0, 0.46, 0.5);
    b.box(M.granite, (x0 + x1) / 2, -0.62, bz + face * (half + 0.06), x1 - x0, 0.14, 0.3);
    b.detail(() => {
      for (let x = x0 + 0.4; x < x1 - 0.2; x += 0.6) b.box(M.balustrade, x, -0.62, bz + face * (half + 0.2), 0.28, 0.16, 0.2);
    });
  }

  // The deck: carriageway between kerbs, a footway each side.
  b.box(M.deck, (x0 + x1) / 2, DECK_TOP - 0.3, bz, x1 - x0, 0.6, BRIDGE_DECK - 4);
  for (const face of [-1, 1]) b.box(M.footway, (x0 + x1) / 2, DECK_TOP - 0.15, bz + face * (half - 1.25), x1 - x0, 0.6, 2.5);

  // Balustrade: plinth, balusters, a rail, broken by pedestals over the piers and at each end.
  for (const face of [-1, 1]) {
    const fz = bz + face * (half - 0.05);
    const posts = [x0 + 0.7, piers[0], piers[1], x1 - 0.7];
    b.box(M.balustrade, (x0 + x1) / 2, DECK_TOP + 0.2, fz, x1 - x0, 0.4, 0.5);
    b.box(M.balustrade, (x0 + x1) / 2, DECK_TOP + 1.12, fz, x1 - x0, 0.16, 0.48);
    for (let x = x0 + 1.2; x < x1 - 1.0; x += 0.34) {
      if (posts.some((p) => Math.abs(x - p) < 0.95)) continue;
      b.detail(() => b.put(M.balustrade, BALUSTER, x, DECK_TOP + 0.4, fz));
    }
    for (const p of posts) {
      const end = p < piers[0] - 1 || p > piers[1] + 1;
      if (end) {
        candelabrum(b, M, p, DECK_TOP, fz, 0, lamps);
      } else {
        // Over a pier the parapet steps out into a refuge on the pilaster, its candelabrum on a pedestal.
        candelabrum(b, M, p, DECK_TOP, fz + face * 0.25, 0, lamps);
      }
    }
  }
  for (const l of lamps) deckLamps.push(l);
}
/** The cutwater's hood: a three-sided pyramid over the nose, sloping back to the pier's face. */
function hoodGeometry(px: number, y: number, zf: number, face: number, hw: number, nose: number, h: number): THREE.BufferGeometry {
  const A = [px - hw, y, zf];
  const B = [px + hw, y, zf];
  const C = [px, y, zf + face * nose];
  const D = [px, y + h, zf];
  const tris = face > 0 ? [A, C, D, C, B, D, A, B, C] : [A, D, C, C, D, B, A, C, B];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(tris.flat(), 3));
  g.computeVertexNormals();
  return g;
}

const BALUSTER = lathe([[0, 0], [0.11, 0], [0.11, 0.06], [0.07, 0.1], [0.06, 0.18], [0.1, 0.36], [0.11, 0.44], [0.07, 0.58], [0.05, 0.62], [0.08, 0.66], [0.11, 0.68], [0.11, 0.72], [0, 0.72]], 8);

// ---------------------------------------------------------------- the steel arch

/**
 * The steel tied arch upstream: two box-section ribs on parabolic lines
 * rising 11 m over the deck, springing from the ends of two plate-girder ties
 * that carry the deck between them (so the arch pushes on nothing: the ties
 * take its thrust). Round hangers every 3.25 m drop the deck from the ribs;
 * a K-braced wind girder joins the ribs over the roadway; cross girders
 * under the deck, stiffeners on the ties, footways cantilevered outside the
 * ribs on brackets, a railing, and lanterns on the tie girders.
 */
function steelArch(b: Build, M: RiverMaterials, bz: number, lamps: THREE.Vector4[], deckLamps: THREE.Vector4[]): void {
  const xa = BANKS.west + 1.5;
  const xb = BANKS.east - 1.5;
  const zr = 8.4; // rib centre lines either side of the road
  const span = xb - xa;
  const rise = 11;
  const tieTop = DECK_TOP + 0.55;
  const ribAt = (x: number): number => tieTop + rise * (1 - ((2 * (x - (xa + xb) / 2)) / span) ** 2);
  // Abutments: stone bearing shelves projecting from each quay wall, a granite bed and the bearings.
  for (const s of [-1, 1]) {
    const face = s < 0 ? BANKS.west : BANKS.east;
    b.box(M.wall, face - s * 1.4, (WALL_FOOT - 1.6) / 2, bz, 2.8, -WALL_FOOT - 1.6, BRIDGE_DECK + 3);
    b.box(M.granite, face - s * 1.4, -1.66, bz, 3.0, 0.2, BRIDGE_DECK + 3.2);
    for (const side of [-1, 1]) b.box(M.steel, face - s * 1.5, -1.4, bz + side * zr, 1.0, 0.32, 1.2);
  }
  // Tie girders: deep plate girders under each rib, with stiffeners on their outer webs.
  for (const side of [-1, 1]) {
    const z = bz + side * zr;
    b.box(M.steel, (xa + xb) / 2, (tieTop - 1.68) / 2, z, span + 3, tieTop + 1.68, 0.7);
    b.box(M.steel, (xa + xb) / 2, tieTop + 0.02, z, span + 3, 0.06, 0.95);
    b.box(M.steel, (xa + xb) / 2, -1.68, z, span + 3, 0.06, 0.95);
    b.detail(() => {
      for (let x = xa - 1.2; x <= xb + 1.2; x += 1.625) b.box(M.steel, x, -0.55, z + side * 0.38, 0.05, 2.1, 0.1);
    });
  }
  // The ribs: welded box sections swept along the parabola, 0.9 wide, 1.25 deep.
  for (const side of [-1, 1]) {
    const z = bz + side * zr;
    const n = 48;
    for (let k = 0; k < n; k++) {
      const u0 = xa + (span * k) / n;
      const u1 = xa + (span * (k + 1)) / n;
      b.beam(M.steel, [u0, ribAt(u0) + 0.62, z], [u1, ribAt(u1) + 0.62, z], 0.9, 1.25);
    }
  }
  // Hangers, with a clevis plate top and bottom (near detail; the ribs and ties carry the far view).
  b.tier = 'detail';
  for (let x = xa + 3.25; x < xb - 1; x += 3.25) {
    for (const side of [-1, 1]) {
      const z = bz + side * zr;
      b.rod(M.iron, [x, tieTop, z], [x, ribAt(x), z], 0.065, 6);
      b.box(M.steel, x, tieTop + 0.2, z, 0.3, 0.4, 0.06);
      b.box(M.steel, x, ribAt(x) - 0.12, z, 0.3, 0.3, 0.06);
    }
    // A cross girder under the deck at every hanger.
    b.box(M.steel, x, -1.1, bz, 0.5, 1.0, 2 * zr);
  }
  b.tier = 'core';
  // Wind bracing over the road: struts where the ribs stand high enough, X braces between them, portals at the ends.
  const clear = DECK_TOP + 6.2;
  const xs: number[] = [];
  for (let x = xa; x <= xb; x += 0.25) if (ribAt(x) > clear) xs.push(x);
  const w0 = xs[0];
  const w1 = xs[xs.length - 1];
  const bays = 6;
  let prev: [number, number] | null = null;
  for (let k = 0; k <= bays; k++) {
    const x = w0 + ((w1 - w0) * k) / bays;
    const y = ribAt(x) + 0.62;
    b.beam(M.steel, [x, y, bz - zr], [x, y, bz + zr], k === 0 || k === bays ? 0.7 : 0.4, k === 0 || k === bays ? 1.1 : 0.45);
    if (prev) {
      const [px, py] = prev;
      b.detail(() => {
        b.beam(M.steel, [px, py, bz - zr], [x, y, bz + zr], 0.22, 0.22);
        b.beam(M.steel, [px, py, bz + zr], [x, y, bz - zr], 0.22, 0.22);
      });
    }
    prev = [x, y];
  }
  // Deck slab between the ties, footways cantilevered outside them on brackets.
  b.box(M.deck, (xa + xb) / 2, DECK_TOP - 0.25, bz, span + 12, 0.5, 2 * zr - 0.7);
  for (const side of [-1, 1]) {
    const zf = bz + side * (zr + 1.15);
    b.box(M.footway, (xa + xb) / 2, DECK_TOP - 0.12, zf, span + 12, 0.24, 1.6);
    b.tier = 'detail';
    for (let x = xa; x <= xb; x += 3.25) b.beam(M.steel, [x, DECK_TOP - 0.25, bz + side * (zr + 0.35)], [x, -0.95, bz + side * (zr + 0.35)], 0.1, 0.12);
    for (let x = xa; x <= xb; x += 3.25) b.beam(M.steel, [x, -0.95, bz + side * (zr + 0.35)], [x, DECK_TOP - 0.25, bz + side * (zr + 1.9)], 0.1, 0.14);
    // Railing: posts, a top rail and two mid rails.
    const zr2 = bz + side * (zr + 1.95);
    for (let x = xa - 6; x <= xb + 6; x += 1.6) b.box(M.iron, x, DECK_TOP + 0.55, zr2, 0.06, 1.1, 0.06);
    for (const y of [1.1, 0.75, 0.4]) b.box(M.iron, (xa + xb) / 2, DECK_TOP + y, zr2, span + 12, 0.05, 0.05);
    b.tier = 'core';
  }
  // Lanterns on the tie girders, at the quarter points and the ends.
  for (const x of [xa - 2, xa + span / 4, xb - span / 4, xb + 2]) {
    for (const side of [-1, 1]) {
      const z = bz + side * (zr + 0.0);
      b.detail(() => {
        b.put(M.iron, LAMP_SHAFT, x, tieTop - 0.6, z, 0, [0.9, 0.95, 0.9]);
        b.put(M.iron, LAMP_CROWN, x, tieTop - 0.6 + 4.62 * 0.95 + 0.35, z, Math.PI / 4);
      });
      b.put(M.lantern, LAMP_GLASS, x, tieTop - 0.6 + 4.62 * 0.95 - 0.05, z, Math.PI / 4);
      const l = new THREE.Vector4(x, tieTop - 0.6 + 4.4, z, 1);
      lamps.push(l);
      deckLamps.push(l);
    }
  }
}

// ---------------------------------------------------------------- the cable-stayed bridge

/**
 * The cable-stayed deck downstream: one concrete pylon on the city's quay,
 * standing in the deck's central reserve and rising 40 m, a semi-fan of
 * eleven stays in a single plane to the main span and five back stays to an
 * anchor block on the approach; a steel box girder with faired edges, a
 * steel railing, slim lamp columns and a red aviation light on the pylon's
 * head, the pylon washed from its foot.
 */
function stayedBridge(b: Build, M: RiverMaterials, bz: number, lamps: THREE.Vector4[], deckLamps: THREE.Vector4[]): void {
  const px = BANKS.east + 5;
  const x0 = BANKS.west - 6;
  const x1 = BANKS.east + QUAY + 20;
  const half = BRIDGE_DECK / 2;
  // The box girder: a faired trapezoid section, 1.6 m deep, extruded along x.
  const sec = new THREE.Shape([
    new THREE.Vector2(-half, DECK_TOP),
    new THREE.Vector2(half, DECK_TOP),
    new THREE.Vector2(half + 0.25, DECK_TOP - 0.35),
    new THREE.Vector2(half - 2.2, DECK_TOP - 1.6),
    new THREE.Vector2(-half + 2.2, DECK_TOP - 1.6),
    new THREE.Vector2(-half - 0.25, DECK_TOP - 0.35),
  ]);
  const girder = new THREE.ExtrudeGeometry(sec, { depth: x1 - x0, bevelEnabled: false });
  girder.rotateY(Math.PI / 2);
  girder.translate(x0, 0, bz);
  b.add(M.steel, girder);
  girder.dispose();
  b.box(M.deck, (x0 + x1) / 2, DECK_TOP + 0.01, bz, x1 - x0, 0.02, BRIDGE_DECK - 5);
  for (const side of [-1, 1]) b.box(M.footway, (x0 + x1) / 2, DECK_TOP + 0.08, bz + side * (half - 1.1), x1 - x0, 0.16, 2.2);
  // Central reserve: a raised kerbed strip carrying the stays' anchorages.
  b.box(M.concrete, (x0 + x1) / 2, DECK_TOP + 0.12, bz, x1 - x0, 0.24, 2.0);
  // Stone bearing shelf on the west bank.
  b.box(M.wall, BANKS.west - 1.2, (WALL_FOOT - 1.8) / 2, bz, 2.4, -WALL_FOOT - 1.8, BRIDGE_DECK + 2);

  // The pylon: a tapered shaft of pale concrete, four-sided with chamfered arrises, a cap with a red light.
  const H = 40;
  const shaft = new THREE.CylinderGeometry(1, 1, 1, 8, 1);
  const n = 10;
  for (let k = 0; k < n; k++) {
    const y0 = -1 + ((H + 1) * k) / n;
    const y1 = -1 + ((H + 1) * (k + 1)) / n;
    const t0 = k / n;
    const t1 = (k + 1) / n;
    const w = (t: number): number => 1.5 - 0.6 * t;
    const d = (t: number): number => 1.15 - 0.4 * t;
    const g = new THREE.CylinderGeometry(1, 1, y1 - y0, 8, 1);
    // Taper this segment: scale its top and bottom rings separately.
    const pos = g.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const top = pos.getY(i) > 0;
      const t = top ? t1 : t0;
      pos.setXYZ(i, pos.getX(i) * w(t), pos.getY(i), pos.getZ(i) * d(t));
    }
    g.computeVertexNormals();
    b.add(M.concrete, g, new THREE.Matrix4().compose(new THREE.Vector3(px, (y0 + y1) / 2, bz), new THREE.Quaternion().setFromAxisAngle(Y, Math.PI / 8), new THREE.Vector3(1, 1, 1)));
    g.dispose();
  }
  shaft.dispose();
  // The head: the shaft closes to a blunt wedge, a steel saddle collar where the stays anchor, the aviation light.
  b.add(M.concrete, new THREE.CylinderGeometry(0.25, 1, 2.6, 8, 1), new THREE.Matrix4().compose(new THREE.Vector3(px, H + 1.3, bz), new THREE.Quaternion().setFromAxisAngle(Y, Math.PI / 8), new THREE.Vector3(0.95, 1, 0.78)));
  b.box(M.steel, px, H - 7.6, bz, 2.05, 13.4, 1.62);
  b.put(M.red, new THREE.SphereGeometry(0.2, 8, 6), px, H + 2.75, bz);
  // Stays: main span to anchorages on the reserve, back stays to the anchor block.
  const anchorsTop = (k: number, m: number): number => H - 1.2 - (k * 13) / m;
  const mains = 11;
  for (let k = 0; k < mains; k++) {
    const ax = px - 9 - k * 5.4;
    const ty = anchorsTop(k, mains);
    b.rod(M.cable, [px - 0.55, ty, bz], [ax, DECK_TOP + 0.3, bz], 0.085, 6);
    b.detail(() => b.rod(M.steel, [ax, DECK_TOP + 0.2, bz], [ax + (px - ax) * 0.02, DECK_TOP + 0.2 + (ty - DECK_TOP) * 0.02, bz], 0.2, 8));
  }
  const backs = 5;
  const block = px + 28;
  for (let k = 0; k < backs; k++) {
    const ax = block - 2 + k * 1.2;
    b.rod(M.cable, [px + 0.55, anchorsTop(k * 2, mains), bz], [ax, DECK_TOP + 1.3, bz], 0.11, 6);
  }
  b.box(M.concrete, block + 0.4, DECK_TOP + 0.75, bz, 7.5, 1.5, 2.0);
  // Railings and lamp columns: steel posts, a flat top rail, infill bars; columns every 11 m with a slim head.
  for (const side of [-1, 1]) {
    const zr = bz + side * (half - 0.12);
    b.detail(() => {
      for (let x = x0; x <= x1; x += 1.4) b.box(M.steel, x, DECK_TOP + 0.6, zr, 0.07, 1.2, 0.05);
    });
    b.box(M.steel, (x0 + x1) / 2, DECK_TOP + 1.18, zr, x1 - x0, 0.06, 0.16);
    for (const y of [0.3, 0.55, 0.8]) b.box(M.steel, (x0 + x1) / 2, DECK_TOP + y, zr, x1 - x0, 0.02, 0.02);
    for (let x = x0 + 4; x <= x1 - 4; x += 11) {
      if (Math.abs(x - px) < 3) continue;
      const zc = bz + side * (half - 0.5);
      b.detail(() => {
        b.rod(M.steel, [x, DECK_TOP, zc], [x, DECK_TOP + 6.8, zc], 0.07, 8);
        b.box(M.steel, x, DECK_TOP + 6.85, zc - side * 0.45, 0.32, 0.1, 1.1);
      });
      b.box(M.lampHead, x, DECK_TOP + 6.79, zc - side * 0.5, 0.22, 0.02, 0.9);
      const l = new THREE.Vector4(x, DECK_TOP + 6.8, zc - side * 0.5, 1.2);
      lamps.push(l);
      deckLamps.push(l);
    }
  }
}

// ---------------------------------------------------------------- piers

/**
 * A ferry pier: river stairs down the quay wall to a landing, a short hinged
 * gangway to a steel pontoon held by two guide piles, and on it a shelter
 * (posts, a glazed back, a canopy with a lit soffit) carrying the pier's
 * lit name sign on both faces.
 */
function ferryPier(b: Build, M: RiverMaterials, p: Pier, row: number, lamps: THREE.Vector4[], pontoonLamps: THREE.Vector4[]): void {
  const s = p.bank === 'west' ? 1 : -1; // toward the river
  const face = p.x;
  // Stairs: 34 risers along the wall face, landing at the bottom.
  const steps = 34;
  const rise = (0 - (WATER_Y + 0.9)) / steps;
  const run = 0.3;
  const sw = 2.0;
  for (let k = 0; k < steps; k++) {
    const y = -rise * (k + 1);
    const z = p.z + 1.2 + k * run;
    b.box(M.granite, face + s * (sw / 2), (y + WALL_FOOT) / 2, z, sw, y - WALL_FOOT, run);
  }
  b.box(M.granite, face + s * (sw / 2), (-0.02 + WALL_FOOT) / 2, p.z - 0.2, sw, -0.02 - WALL_FOOT, 2.8);
  const landZ = p.z + 1.2 + steps * run + 1.5;
  b.box(M.granite, face + s * (sw / 2), (WATER_Y + 0.9 + WALL_FOOT) / 2, landZ, sw, WATER_Y + 0.9 - WALL_FOOT, 3);
  // The stair's outer wall and handrail.
  b.beam(M.granite, [face + s * (sw + 0.18), 0.45, p.z - 1.6], [face + s * (sw + 0.18), 0.45, p.z + 1.2], 0.36, 0.9);
  b.beam(M.granite, [face + s * (sw + 0.18), 0.45, p.z + 1.2], [face + s * (sw + 0.18), WATER_Y + 1.35, p.z + 1.2 + steps * run], 0.36, 0.9);
  b.tier = 'detail';
  b.beam(M.iron, [face + s * (sw - 0.05), 0.9, p.z + 1.2], [face + s * (sw - 0.05), WATER_Y + 1.9, p.z + 1.2 + steps * run], 0.05, 0.05);
  // Pontoon: 28 m by 7 m, off the stairs' landing.
  const gx0 = face + s * (sw + 0.4);
  const pw = 7;
  const pcx = gx0 + s * (3.2 + pw / 2);
  const pz = landZ - 3;
  const deckY = WATER_Y + 0.85;
  b.tier = 'core';
  b.box(M.hull, pcx, WATER_Y + 0.1, pz, pw, 1.5, PIER_HALF * 2);
  b.box(M.timber, pcx, deckY + 0.04, pz, pw - 0.2, 0.08, PIER_HALF * 2 - 0.2);
  b.tier = 'detail';
  // Rubbing strake round the hull, a shade lighter.
  for (const side of [-1, 1]) b.box(M.timber, pcx + side * (pw / 2 + 0.1), deckY - 0.25, pz, 0.22, 0.24, PIER_HALF * 2);
  // Gangway from the landing to the pontoon, with its side rails.
  const gy = deckY + 0.05;
  b.beam(M.steel, [gx0 - s * 0.2, WATER_Y + 0.95, landZ - 0.2], [gx0 + s * 3.4, gy, landZ - 0.2], 1.6, 0.14);
  for (const side of [-0.8, 0.8]) b.beam(M.iron, [gx0 - s * 0.2, WATER_Y + 1.95, landZ - 0.2 + side], [gx0 + s * 3.4, gy + 1.0, landZ - 0.2 + side], 0.05, 0.05);
  // Guide piles at the pontoon's outer edge, through hoops.
  for (const dz of [-PIER_HALF + 3, PIER_HALF - 3]) {
    const x = pcx + s * (pw / 2 + 0.55);
    b.rod(M.steel, [x, WALL_FOOT, pz + dz], [x, deckY + 3.4, pz + dz], 0.34, 10);
    b.box(M.steel, x - s * 0.35, deckY + 0.3, pz + dz, 0.8, 0.25, 0.9);
  }
  // Railings round the pontoon, open on its river edge's boarding gate.
  for (const side of [-1, 1]) b.box(M.iron, pcx, deckY + 1.05, pz + side * (PIER_HALF - 0.1), pw - 0.4, 0.05, 0.05);
  b.box(M.iron, pcx - s * (pw / 2 - 0.1), deckY + 1.05, pz, 0.05, 0.05, PIER_HALF * 2 - 0.4);
  for (let dz = -PIER_HALF + 0.6; dz <= PIER_HALF - 0.6; dz += 1.8) b.box(M.iron, pcx - s * (pw / 2 - 0.1), deckY + 0.52, pz + dz, 0.05, 1.05, 0.05);
  // The shelter: four posts, a glazed back toward the wall, a canopy, a bench.
  const sx = pcx - s * 0.4;
  const len = 12;
  for (let k = 0; k < 4; k++) {
    const z = pz - len / 2 + (k * len) / 3;
    b.box(M.steel, sx - s * 1.6, deckY + 1.35, z, 0.14, 2.7, 0.14);
  }
  b.box(M.glass, sx - s * 1.62, deckY + 1.25, pz, 0.03, 2.2, len);
  b.box(M.timber, sx - s * 1.25, deckY + 0.48, pz, 0.45, 0.08, len - 2);
  b.tier = 'core';
  b.box(M.steel, sx, deckY + 2.78, pz, 3.8, 0.16, len + 1.2);
  b.box(M.lampHead, sx, deckY + 2.69, pz, 2.6, 0.02, len - 1);
  // The sign: a lit enamel panel along the canopy's fascia, on both faces.
  const signW = 6.4;
  const signH = 0.8;
  const sg = signGeometry(row, signW, signH);
  for (const side of [-1, 1]) {
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(sx + side * 1.94, deckY + 3.32, pz),
      new THREE.Quaternion().setFromAxisAngle(Y, side < 0 ? -Math.PI / 2 : Math.PI / 2),
      new THREE.Vector3(1, 1, 1),
    );
    b.add(M.sign, sg, m);
    b.box(M.steel, sx + side * 1.9, deckY + 3.32, pz, 0.06, signH + 0.12, signW + 0.12);
  }
  sg.dispose();
  // Two posts carry the sign on the canopy.
  b.detail(() => {
    for (const dz of [-signW / 2 + 0.5, signW / 2 - 0.5]) b.box(M.steel, sx, deckY + 2.95, pz + dz, 0.12, 0.34, 0.12);
  });
  pontoonLamps.push(new THREE.Vector4(sx, deckY + 2.6, pz - 3, 0.5), new THREE.Vector4(sx, deckY + 2.6, pz + 3, 0.5));
  lamps.push(new THREE.Vector4(sx, deckY + 2.6, pz, 0.8));
}

/** A plane w by h showing row `row` of the sign atlas. */
function signGeometry(row: number, w: number, h: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - (row + 1 - uv.getY(i)) / SIGN_ROWS);
  return g;
}

const SIGN_ROWS = 8;

/** The pier signs: one row each, cream lettering on dark green enamel, lit from behind. */
function signAtlas(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024;
  c.height = 128 * SIGN_ROWS;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  const draw = (): void => {
    const g = c.getContext('2d');
    if (!g) return;
    for (let r = 0; r < SIGN_ROWS; r++) {
      const y = r * 128;
      g.fillStyle = '#123a33';
      g.fillRect(0, y, 1024, 128);
      g.strokeStyle = '#d9cfb3';
      g.lineWidth = 4;
      g.strokeRect(10, y + 10, 1004, 108);
      g.fillStyle = '#efe6cc';
      g.font = '600 62px "IBM Plex Sans", Helvetica, Arial, sans-serif';
      g.textBaseline = 'middle';
      g.fillText(PIER_NAMES[r] ?? '', 44, y + 66);
      g.font = '500 34px "IBM Plex Sans", Helvetica, Arial, sans-serif';
      g.textAlign = 'right';
      g.fillText('Ferry', 984, y + 68);
      g.textAlign = 'left';
    }
    t.needsUpdate = true;
  };
  draw();
  void document.fonts?.load('600 62px "IBM Plex Sans"').then(draw, () => {});
  return t;
}

// ---------------------------------------------------------------- the water

const WATER_VERTEX = /* glsl */ `
  varying vec3 vW;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }`;

function waterFragment(steps: number): string {
  return /* glsl */ `
  #include <packing>
  uniform sampler2D tScene;
  uniform sampler2D tDepth;
  uniform vec2 uRes;
  uniform float uNear;
  uniform float uFar;
  uniform float uTime;
  uniform float uFog;
  uniform mat4 uProj;
  uniform int uSteps;
  uniform vec4 uWakes[${WAKES}];
  uniform int uWakeN;
  varying vec3 vW;
  ${SKY_GLSL}
  const float WEST = ${BANKS.west.toFixed(2)};
  const float EAST = ${BANKS.east.toFixed(2)};
  const vec3 SUN = vec3(${SUN_DIRECTION.x.toFixed(5)}, ${SUN_DIRECTION.y.toFixed(5)}, ${SUN_DIRECTION.z.toFixed(5)});
  const float BRIDGE_Z[3] = float[3](${BRIDGES.map((z) => z.toFixed(1)).join(', ')});
  const float BRIDGE_HALF = ${(BRIDGE_DECK / 2).toFixed(2)};
  const float FAR_FROM = 260.0;
  const float FAR_FULL = 900.0;

  float wHash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
  // Slopes of a field of small waves: wind ripples across the channel and longer swells running with the current.
  vec2 waveSlope(vec2 p, float t) {
    vec2 g = vec2(0.0);
    // Direction, wavelength (m), amplitude (m), each a deep-water wave moving at its own speed.
    const int N = 9;
    vec3 W[N] = vec3[N](
      vec3( 0.20, 1.00, 7.0), vec3(-0.55, 0.83, 4.3), vec3( 0.80, 0.60, 2.9),
      vec3(-0.15, 0.99, 1.9), vec3( 0.62,-0.78, 1.3), vec3(-0.92, 0.38, 0.95),
      vec3( 0.35, 0.94, 0.7), vec3(-0.70,-0.71, 0.52), vec3( 0.97, 0.24, 0.41));
    for (int i = 0; i < N; i++) {
      vec2 d = normalize(W[i].xy);
      float L = W[i].z;
      float k = 6.28318 / L;
      // Each wave's slope is small (a quiet urban river, no wind to speak of), and its strength wanders in
      // patches so the surface never reads as rows of the same ripple.
      float slope = 0.032 * (0.45 + 0.55 * L / 7.0);
      float w = sqrt(9.81 * k);
      float ph = k * dot(d, p) - w * t + float(i) * 1.7;
      vec2 cell = p / (L * 9.0) + float(i) * 3.1;
      vec2 ci = floor(cell); vec2 cf = fract(cell); cf = cf * cf * (3.0 - 2.0 * cf);
      float strength = mix(mix(wHash(ci), wHash(ci + vec2(1, 0)), cf.x), mix(wHash(ci + vec2(0, 1)), wHash(ci + vec2(1, 1)), cf.x), cf.y);
      g += d * slope * (0.25 + 1.1 * strength) * cos(ph);
    }
    // The current: everything drifts south.
    return g;
  }
  vec3 waterNormal(vec2 p, float t, float fade) {
    vec2 drift = vec2(0.0, -0.45 * t);
    vec2 g = waveSlope(p + drift, t) * 0.8 + waveSlope(p * 2.3 + drift * 2.3 + 17.0, t * 1.5) * 0.3;
    g *= fade;
    return normalize(vec3(-g.x, 1.0, -g.y));
  }

  // A boat's wake (vehicles.ts ferries): the Kelvin wedge spreading from the bow at 19.5 degrees, its divergent
  // crests along each arm and transverse ones inside, and the churned white water behind the stern, all fading with
  // distance astern and with the boat's speed. Returns the surface's added slope (xy) and how much foam (z).
  float wNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(wHash(i), wHash(i + vec2(1, 0)), f.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), f.x), f.y);
  }
  vec3 wakes(vec2 p, float dist, float vy) {
    vec2 g = vec2(0.0);
    float foam = 0.0;
    // Crests finer than a few pixels only alias: they fade with distance, and with how far their phase runs across
    // one pixel (the pixel's footprint on the water, stretched at a glancing view), leaving the wake's broad shape
    // and its foam. Worked out rather than taken from derivatives, which are not defined past the discard above.
    float near = 1.0 - smoothstep(90.0, 260.0, dist);
    float footprint = dist * 0.0007 / max(vy, 0.04);
    for (int i = 0; i < ${WAKES}; i++) {
      if (i >= uWakeN) break;
      vec4 w = uWakes[i];
      float sp = clamp(w.w, 0.0, 1.2);
      if (sp < 0.03) continue;
      vec2 dir = vec2(cos(w.z), sin(w.z));
      vec2 side = vec2(-dir.y, dir.x);
      vec2 r = p - w.xy;
      float u = -dot(r, dir);
      float a = dot(r, side);
      float aa = abs(a);
      float b = u + 10.0;
      if (b < 0.0 || b > 220.0) continue;
      // Outside the wedge (its arms at their widest wander) nothing of the wake reaches: skip the noise there.
      if (aa > 2.4 + 0.394 * b + 3.0 * (1.1 + 0.05 * b) + 3.0) continue;
      float decay = sp * exp(-b / 90.0);
      float width = 1.1 + 0.05 * b;
      float edge0 = 2.4 + 0.354 * b;
      float wander = 0.3 + 0.02 * b;
      // Close to the boat the arms stand up: a V that reads behind it, not only the churn in its track.
      float close = 1.0 + 1.6 * exp(-b / 45.0);
      // The arms: divergent crests as continuous ridge lines running in across each arm of the 19.5 degree wedge,
      // their spacing and strength wandering with noise and fading astern and with distance; only the foam breaks up.
      float band = 2.6 * width;
      if (b < 150.0 && abs(aa - edge0) < band + wander + width) {
        // One slow noise steers the arm's line, its ridges' spacing and their strength.
        float flow = wNoise(vec2(aa * 0.05 + uTime * 0.05, b * 0.04 - uTime * 0.08));
        float edge = edge0 + (flow - 0.5) * wander;
        float armD = aa - edge;
        // A broad, one-sided envelope: the ridges reach in from the arm's line toward the track, not out past it.
        float env = exp(-armD * armD / (band * band)) * smoothstep(width * 1.2, -width * 0.2, armD);
        // The ridge lines cross the arm at about 35 degrees; their spacing stretches and squeezes slowly.
        float spacing = 1.0 + 0.35 * (flow - 0.5);
        float ph = (aa * 0.82 + b * 0.57) * 1.15 / spacing - uTime * 2.0;
        float crestFade = (1.0 - smoothstep(0.5, 1.4, 1.15 * footprint)) * near;
        float strength = 0.6 + 0.8 * fract(flow * 3.7 + 0.21);
        float s0 = sin(ph);
        float c0 = 0.5 + 0.5 * s0;
        float sharp = mix(3.0, 1.4, smoothstep(10.0, 140.0, b));
        float dcrest = sharp * pow(c0, sharp - 1.0) * cos(ph) * 0.5;
        vec2 across = normalize(side * sign(a) * 0.82 - dir * 0.57);
        g += across * dcrest * env * decay * 0.17 * close * strength * crestFade;
        // The swell under the arm: the gradient of a smooth ridge.
        g += side * sign(a) * (-2.0 * armD / (width * width)) * exp(-armD * armD / (width * width)) * decay * 0.1 * close;
        // Foam only on the ridge tops near the boat, broken up by its own noise.
        float tip = pow(c0, 6.0) * env * smoothstep(80.0, 4.0, b) * crestFade;
        if (tip > 0.01) foam += tip * decay * 0.5 * close * smoothstep(0.45, 0.85, wNoise(vec2(aa * 0.9 - uTime * 0.3, b * 0.9 + uTime * 0.2)));
      }
      // The churn astern of the hull (its stern stands 11 m behind the middle), and white water along its sides.
      float s = u - 10.5;
      float churn = s > -1.0 ? exp(-aa * aa / (2.4 + 0.2 * max(s, 0.0))) * exp(-max(s, 0.0) / (24.0 + 40.0 * sp)) : 0.0;
      float hullW = 3.15 * sqrt(max(0.0, 1.0 - (u / 11.2) * (u / 11.2)));
      float sideF = exp(-pow(aa - hullW - 0.35, 2.0) / 0.35) * smoothstep(-11.6, -9.0, u) * (1.0 - smoothstep(6.0, 12.0, u));
      if (churn + sideF > 0.01) {
        vec2 q = vec2(a * 0.7, s * 0.32 - uTime * 0.45);
        float n1 = wNoise(q);
        float n = n1 * 0.55 + wNoise(q * 2.1 + 7.1) * 0.3 + wNoise(q * 4.3 + 2.0) * 0.15;
        foam += churn * sp * smoothstep(0.15, 0.85, n + 0.35 * exp(-max(s, 0.0) / 10.0));
        // Far off the churn's noise is finer than a pixel; a broad pale track stays, catching the sky, so the
        // ferry's wake reads from home.
        foam += churn * sp * 0.4 * smoothstep(140.0, 420.0, dist);
        g += vec2(n - 0.5, n1 - n) * churn * sp * 0.5 * near;
        foam += sideF * sp * 0.5 * smoothstep(0.2, 0.8, n);
      }
    }
    return vec3(g, foam);
  }

  float viewZ(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    return d >= 0.999999 ? 1e9 : -perspectiveDepthToViewZ(d, uNear, uFar);
  }

  // March the reflected ray over the frame's depth; returns the colour it meets and how sure the hit is.
  vec3 trace(vec3 P, vec3 R, out float hit) {
    hit = 0.0;
    float t = 0.4;
    float prev = 0.0;
    for (int i = 0; i < ${steps}; i++) {
      if (i >= uSteps) break;
      vec3 S = P + R * t;
      vec4 vs = viewMatrix * vec4(S, 1.0);
      if (vs.z > -uNear) break;
      vec4 cs = uProj * vs;
      vec2 uv = cs.xy / cs.w * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) break;
      float sz = viewZ(uv);
      float rz = -vs.z;
      float thick = max(1.2, (t - prev) * 2.2 + t * 0.02);
      if (rz > sz && rz - sz < thick) {
        float a = prev;
        float b = t;
        for (int j = 0; j < 6; j++) {
          float m = 0.5 * (a + b);
          vec4 mv = viewMatrix * vec4(P + R * m, 1.0);
          vec4 mc = uProj * mv;
          vec2 muv = mc.xy / mc.w * 0.5 + 0.5;
          if (-mv.z > viewZ(muv)) b = m; else a = m;
        }
        vec4 fv = uProj * (viewMatrix * vec4(P + R * b, 1.0));
        vec2 fuv = fv.xy / fv.w * 0.5 + 0.5;
        vec2 e = smoothstep(0.0, 0.06, fuv) * smoothstep(0.0, 0.06, 1.0 - fuv);
        hit = e.x * e.y;
        return texture2D(tScene, fuv).rgb;
      }
      prev = t;
      t = t * 1.13 + 0.22;
    }
    return vec3(0.0);
  }

  void main() {
    vec2 suv = gl_FragCoord.xy / uRes;
    float myZ = -(viewMatrix * vec4(vW, 1.0)).z;
    // Something stands in front of the water here (a wall, a pier, a bridge): it keeps the pixel.
    float sceneZ = viewZ(suv);
    if (sceneZ < myZ - 0.02) discard;

    vec3 toEye = cameraPosition - vW;
    float dist = length(toEye);
    vec3 V = toEye / dist;
    // Ripples fade with distance (they would only alias) and at grazing angles, where water reads as a mirror.
    float fade = 1.0 / (1.0 + dist / 260.0);
    vec3 N = waterNormal(vW.xz, uTime, fade);
    vec3 wk = wakes(vW.xz, dist, V.y);
    N = normalize(vec3(N.x - wk.x, N.y, N.z - wk.y));
    vec3 R = reflect(-V, N);
    R.y = max(R.y, 0.004);
    R = normalize(R);
    float NdV = clamp(dot(N, V), 0.0, 1.0);
    float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
    // Far off, the ripples are finer than a pixel: the water reflects as a rough surface, whose mean reflectance
    // at a glancing view runs well above a smooth one's. Under FAR_FROM metres nothing changes.
    float far = smoothstep(FAR_FROM, FAR_FULL, dist);
    F = mix(F, min(1.0, F * 2.2 + 0.035), far);

    float hit;
    vec3 seen = trace(vW, R, hit);
    vec3 sky = skyColor(R);
    vec3 refl = mix(sky, seen, hit);

    // Under a bridge the sky is shut out: what reflects there is the bridge's own shadowed soffit.
    float under = 0.0;
    for (int i = 0; i < 3; i++) under = max(under, 1.0 - smoothstep(BRIDGE_HALF - 1.0, BRIDGE_HALF + 2.0, abs(vW.z - BRIDGE_Z[i])));
    refl = mix(refl, seen * hit + sky * (1.0 - hit) * 0.08, under * (1.0 - hit * 0.5));

    // The river's own body: a deep green-brown, faintly lit by the sky it scatters.
    vec3 body = vec3(0.010, 0.016, 0.015) + skyHaze(vec3(0.0, 0.0, 1.0)) * 0.012;
    vec3 col = mix(body, refl, F);

    // The sun itself, only where the low western sun clears the west quay's parapet.
    float tSun = (vW.x - WEST) / max(-SUN.x, 1e-3);
    float lit = smoothstep(0.0, 1.0, (${WATER_Y.toFixed(2)} + SUN.y * tSun) - 1.0);
    float glint = pow(max(dot(R, SUN), 0.0), 900.0) * 60.0 + pow(max(dot(R, SUN), 0.0), 90.0) * 1.2;
    col += vec3(1.0, 0.62, 0.32) * glint * lit * F * (1.0 - under);

    // Along each wall the water lies in the wall's shadow and takes its dark reflection: a darker line at the foot.
    float dw = min(vW.x - WEST, EAST - vW.x);
    col *= mix(0.5, 1.0, smoothstep(0.0, 4.0, dw));
    // From afar each row of quay lamps lays a warm band down the water beside its wall: the sum of streaks too fine
    // for the march to find at that distance (close up the march draws each one itself).
    float row = exp(-max(dw - 0.5, 0.0) / 4.5) * (1.0 - smoothstep(${QUAY_LAMP_REACH.toFixed(1)} - 60.0, ${QUAY_LAMP_REACH.toFixed(1)}, abs(vW.z)));
    col += vec3(1.0, 0.72, 0.42) * 0.75 * row * far;

    // Foam: broken white water lit by the dusk sky above it.
    float foam = clamp(wk.z, 0.0, 1.0);
    col = mix(col, skyHaze(vec3(0.0, 1.0, 0.0)) * 0.5 + refl * 0.25 + vec3(0.01, 0.011, 0.012), smoothstep(0.0, 1.0, foam) * 0.75);

    // The same sky-coloured haze the scene's fog draws.
    float ff = 1.0 - exp(-uFog * uFog * dist * dist);
    col = mix(col, skyHaze(-V), ff);
    gl_FragColor = vec4(col, 1.0);
  }`;
}

/**
 * The water's pass in the post chain: copies the scene's frame through and
 * draws the water over it, reading the frame's colour and depth.
 */
class WaterPass extends Pass {
  private copy: FullScreenQuad;
  /** The frame at reduced resolution, which the reflections read from when the settings ask for it (medium). */
  private small: THREE.WebGLRenderTarget | null = null;
  constructor(
    private water: { scene: THREE.Scene; material: THREE.ShaderMaterial; settings: { steps: number; colourScale: number } },
    private camera: THREE.PerspectiveCamera,
  ) {
    super();
    this.needsSwap = true;
    this.copy = new FullScreenQuad(new THREE.ShaderMaterial({ ...CopyShader, uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms) }));
  }
  render(renderer: THREE.WebGLRenderer, writeBuffer: THREE.WebGLRenderTarget, readBuffer: THREE.WebGLRenderTarget): void {
    const copy = this.copy.material as THREE.ShaderMaterial;
    const u = this.water.material.uniforms;
    const scale = this.water.settings.colourScale;
    u.tScene.value = readBuffer.texture;
    if (scale < 1) {
      const w = Math.max(1, Math.round(readBuffer.width * scale));
      const h = Math.max(1, Math.round(readBuffer.height * scale));
      if (!this.small) this.small = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
      if (this.small.width !== w || this.small.height !== h) this.small.setSize(w, h);
      copy.uniforms.tDiffuse.value = readBuffer.texture;
      renderer.setRenderTarget(this.small);
      this.copy.render(renderer);
      u.tScene.value = this.small.texture;
    }
    copy.uniforms.tDiffuse.value = readBuffer.texture;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.copy.render(renderer);
    u.tDepth.value = readBuffer.depthTexture;
    u.uRes.value.set(readBuffer.width, readBuffer.height);
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    u.uProj.value.copy(this.camera.projectionMatrix);
    u.uSteps.value = this.water.settings.steps;
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.render(this.water.scene, this.camera);
    renderer.autoClear = auto;
  }
  dispose(): void {
    this.small?.dispose();
    this.copy.material.dispose();
    this.copy.dispose();
  }
}

// ---------------------------------------------------------------- the river

export interface River {
  /** The quays, bridges and piers: one group per chunk along the river (river-lod.ts), a core and a detail tier in each. */
  group: THREE.Group;
  /** A post pass that draws the water over the frame (post.ts puts it straight after the scene). */
  pass(camera: THREE.PerspectiveCamera): Pass;
  /**
   * Advances the ripples, takes the scene's haze, and sets each chunk's
   * detail, shadow and AO from where the camera stands. Returns true when a
   * chunk's shadow casting changed (the shadow map must be redrawn).
   */
  update(dt: number, fogDensity: number, eye: THREE.Vector3): boolean;
  /** The march's steps and the resolution of its colour source (river-lod.ts waterSettings); the quality drop lowers them. */
  setQuality(q: 'high' | 'medium'): void;
  /** The boats' wakes on the water: where each boat is, which way it goes and how fast against its service speed (at most WAKES). */
  setWakes(wakes: ReadonlyArray<{ x: number; z: number; heading: number; speed: number }>): void;
  /** Compiles the water's shader (it is not in the scene). */
  compile(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void;
  /** Every lantern on the quays, bridges and piers, in the world (tests and captures). */
  lamps: THREE.Vector4[];
  /**
   * What draws from this camera: the river's meshes and triangles in the
   * camera's frustum (the main pass), the water's settings, and whether the
   * water drew since last asked (tests).
   */
  view(camera: THREE.Camera): { meshes: number; triangles: number; drewWater: boolean; steps: number; colourScale: number };
  dispose(): void;
}

export function createRiver(quality: 'high' | 'medium'): River {
  const L = materials();
  const lamps: THREE.Vector4[] = [];
  const deckLamps: THREE.Vector4[] = [];
  const pontoonLamps: THREE.Vector4[] = [];
  const signs = signAtlas();
  const M: RiverMaterials = {
    wall: riverStone('ashlar', 2.4, 0x8d8982, 'wall', 0.5, { h: 0.62, l: 1.5 }),
    granite: riverStone('granite', 1.6, 0x7f7c77, 'granite', 0.8),
    bridgeStone: riverStone('ashlar', 2.0, 0xb9b2a4, 'bridge', 0.5, { h: 0.48, l: 1.1 }),
    balustrade: riverStone('sand', 2.2, 0xe9dfcc, 'balustrade', 0.7),
    iron: L.darkMetal,
    steel: uplit(new THREE.MeshStandardMaterial({ color: 0x3c4f47, metalness: 0.55, roughness: 0.42 }), 'steel', 0, 9, 0.35, new THREE.Color(1.0, 0.8, 0.6)),
    concrete: uplit(new THREE.MeshStandardMaterial({ color: 0xbdb7ac, roughness: 0.82 }), 'pylon', 0, 14, 0.55, new THREE.Color(1.0, 0.86, 0.7)),
    cable: new THREE.MeshStandardMaterial({ color: 0xd9dad6, roughness: 0.3, metalness: 0.1 }),
    deck: new THREE.MeshStandardMaterial({ color: 0x0b0c0d, roughness: 0.8 }),
    footway: new THREE.MeshStandardMaterial({ color: 0x6f6a64, roughness: 0.75 }),
    hull: new THREE.MeshStandardMaterial({ color: 0x14181b, roughness: 0.55, metalness: 0.3 }),
    timber: new THREE.MeshStandardMaterial({ color: 0x4b3d30, roughness: 0.85 }),
    glass: L.glass,
    lantern: new THREE.MeshBasicMaterial({ color: LANTERN }),
    lampHead: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.86, 0.66).multiplyScalar(3.0) }),
    red: new THREE.MeshBasicMaterial({ color: new THREE.Color(4.0, 0.25, 0.12) }),
    sign: new THREE.MeshBasicMaterial({ map: signs, color: new THREE.Color(1.25, 1.25, 1.25) }),
  };

  const b = new Build();
  buildQuays(b, M, lamps);
  for (const bz of BRIDGES) {
    const kind = BRIDGE_KINDS[bz];
    const own: THREE.Vector4[] = [];
    if (kind === 'stone') stoneBridge(b, M, bz, own, deckLamps);
    else if (kind === 'arch') steelArch(b, M, bz, own, deckLamps);
    else stayedBridge(b, M, bz, own, deckLamps);
    lamps.push(...own);
  }
  PIERS.forEach((p, i) => ferryPier(b, M, p, i, lamps, pontoonLamps));
  // Decks and pontoons take their lamps' pools of light.
  pooled(M.deck, 'deck', deckLamps);
  pooled(M.footway, 'footway', deckLamps);
  pooled(M.timber, 'timber', pontoonLamps);

  const group = new THREE.Group();
  group.name = 'river';
  const noShadow = new Set<THREE.Material>([M.lantern, M.lampHead, M.red, M.sign, M.glass, M.cable]);
  const parts = b.chunks((m) => !noShadow.has(m));
  for (const c of parts) group.add(c.group);
  const far = farCores(parts);
  for (const f of far) group.add(f.mesh);
  /** Draws the chunks past the near run [i0, i1) (no near run: i0 = i1) from the far core, in at most two runs. */
  function farRuns(i0: number, i1: number): void {
    for (const f of far) {
      const g = f.mesh.geometry;
      g.clearGroups();
      const run = (a: number, z: number): void => {
        let start = -1;
        let end = 0;
        for (let k = a; k < z; k++) {
          const sp = f.spans[k];
          if (!sp) continue;
          if (start < 0) start = sp.start;
          end = sp.start + sp.count;
        }
        if (start >= 0) g.addGroup(start, end - start, 0);
      };
      run(0, i0);
      run(i1, parts.length);
      f.mesh.visible = g.groups.length > 0;
    }
  }

  // The water: one plane the length of the river, drawn by its own pass.
  const waterGeo = new THREE.PlaneGeometry(RIVER.width + 1, LENGTH, 1, 1).rotateX(-Math.PI / 2);
  waterGeo.translate(RIVER.x, WATER_Y, 0);
  const settings = { ...waterSettings(quality) };
  const material = new THREE.ShaderMaterial({
    vertexShader: WATER_VERTEX,
    fragmentShader: waterFragment(64),
    uniforms: {
      tScene: { value: null },
      tDepth: { value: null },
      uRes: { value: new THREE.Vector2(1, 1) },
      uNear: { value: 1 },
      uFar: { value: 1000 },
      uTime: { value: 0 },
      uFog: { value: 0 },
      uProj: { value: new THREE.Matrix4() },
      uSteps: { value: settings.steps },
      uWakes: { value: Array.from({ length: WAKES }, () => new THREE.Vector4()) },
      uWakeN: { value: 0 },
    },
    depthTest: false,
    depthWrite: false,
  });
  const waterMesh = new THREE.Mesh(waterGeo, material);
  waterMesh.frustumCulled = false;
  waterMesh.name = 'water';
  const waterScene = new THREE.Scene();
  waterScene.add(waterMesh);
  const water = { scene: waterScene, material, settings };
  let time = 0;
  let drew = false;
  waterMesh.onAfterRender = () => {
    drew = true;
  };
  /** Where the LOD was last set from: it is set again only once the eye has moved a few metres. */
  const lodAt = new THREE.Vector3(Infinity, Infinity, Infinity);
  const frustum = new THREE.Frustum();
  const vp = new THREE.Matrix4();

  return {
    group,
    lamps,
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
      }
      // The far core: one call per run.
      for (const f of far) {
        if (!f.mesh.visible) continue;
        for (const gr of f.mesh.geometry.groups) {
          meshes++;
          triangles += gr.count / 3;
        }
      }
      const out = { meshes, triangles, drewWater: drew, ...settings };
      drew = false;
      return out;
    },
    pass: (camera) => new WaterPass(water, camera),
    setWakes(wakes) {
      const list = material.uniforms.uWakes.value as THREE.Vector4[];
      const n = Math.min(wakes.length, WAKES);
      for (let i = 0; i < n; i++) list[i].set(wakes[i].x, wakes[i].z, wakes[i].heading, wakes[i].speed);
      material.uniforms.uWakeN.value = n;
    },
    setQuality(q) {
      Object.assign(settings, waterSettings(q));
      material.uniforms.uSteps.value = settings.steps;
    },
    update(dt, fogDensity, eye) {
      time += dt;
      material.uniforms.uTime.value = time;
      material.uniforms.uFog.value = fogDensity;
      if (eye.distanceToSquared(lodAt) < 25) return false;
      lodAt.copy(eye);
      let shadows = false;
      // The chunks near enough to draw their detail draw their own core too; the rest draw from the far core.
      let i0 = parts.length;
      let i1 = parts.length;
      parts.forEach((c, k) => {
        if (!chunkLod(eye, c.chunk).detail) return;
        if (i0 === parts.length) i0 = k;
        i1 = k + 1;
      });
      parts.forEach((c, k) => {
        c.group.visible = k >= i0 && k < i1;
      });
      farRuns(i0, i1);
      for (const c of parts) {
        const lod = chunkLod(eye, c.chunk);
        if (c.lod && c.lod.detail === lod.detail && c.lod.shadow === lod.shadow && c.lod.ao === lod.ao) continue;
        if (c.lod?.shadow !== lod.shadow) shadows = true;
        c.lod = lod;
        c.detail.visible = lod.detail;
        for (const m of c.casters) m.castShadow = lod.shadow;
        // Past the AO's reach a chunk draws in the view and the shadow map only (lod.ts LAYER).
        for (const tier of [c.core, c.detail]) for (const o of tier.children) {
          if (lod.ao) o.layers.set(0);
          else setLayers(o, LAYER.view, LAYER.shadow);
        }
      }
      return shadows;
    },
    compile(renderer, camera) {
      renderer.compile(waterScene, camera);
    },
    dispose() {
      for (const c of parts) for (const tier of [c.core, c.detail]) for (const o of tier.children) (o as THREE.Mesh).geometry.dispose();
      for (const f of far) f.mesh.geometry.dispose();
      for (const m of Object.values(M)) if (m !== L.darkMetal && m !== L.glass) m.dispose();
      signs.dispose();
      waterGeo.dispose();
      material.dispose();
    },
  };
}
