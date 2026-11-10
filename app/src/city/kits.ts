import * as THREE from 'three';

/**
 * The architecture kits authored in Blender by tools/kits/kits.py and
 * written to app/public/kits/kits.glb: masonry courses with real joint
 * relief, the sci-fi crowns and family modules, and the ambient city's roof
 * and massing pieces. One GLB, one mesh per named piece (see the script's
 * header for each piece's frame). The app loads it once before the first
 * city build (`loadKits`); node tests register the same file from disk
 * (`registerKits`). Pure geometry: no materials, no textures.
 */

const pieces = new Map<string, THREE.BufferGeometry>();

/** Parses a GLB written by the kit script into one geometry per mesh node, by node name. */
export function parseGlb(buf: ArrayBuffer): Map<string, THREE.BufferGeometry> {
  const view = new DataView(buf);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error('kits: not a GLB');
  let off = 12;
  let json: GltfJson | null = null;
  let bin: ArrayBuffer | null = null;
  while (off < buf.byteLength) {
    const len = view.getUint32(off, true);
    const type = view.getUint32(off + 4, true);
    const body = buf.slice(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(body)) as GltfJson;
    else if (type === 0x004e4942) bin = body;
    off += 8 + len;
  }
  if (!json || !bin) throw new Error('kits: GLB without JSON or BIN chunk');
  const g = json;
  const data = bin;
  const read = (i: number): { array: Float32Array | Uint32Array; size: number } => {
    const a = g.accessors[i];
    const bv = g.bufferViews[a.bufferView];
    const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type] ?? 1;
    const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const n = a.count * size;
    const stride = bv.byteStride;
    const src = new DataView(data, start);
    const bytes = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[a.componentType] ?? 4;
    const step = stride ?? size * bytes;
    const out = a.componentType === 5126 || a.normalized ? new Float32Array(n) : new Uint32Array(n);
    for (let e = 0; e < a.count; e++) {
      for (let c = 0; c < size; c++) {
        const o = e * step + c * bytes;
        let v: number;
        switch (a.componentType) {
          case 5126: v = src.getFloat32(o, true); break;
          case 5125: v = src.getUint32(o, true); break;
          case 5123: v = src.getUint16(o, true); if (a.normalized) v /= 65535; break;
          case 5121: v = src.getUint8(o); if (a.normalized) v /= 255; break;
          default: throw new Error(`kits: component type ${a.componentType}`);
        }
        out[e * size + c] = v;
      }
    }
    return { array: out, size };
  };
  const result = new Map<string, THREE.BufferGeometry>();
  for (const node of g.nodes) {
    if (node.mesh === undefined) continue;
    const prim = g.meshes[node.mesh].primitives[0];
    const geo = new THREE.BufferGeometry();
    const pos = read(prim.attributes.POSITION);
    geo.setAttribute('position', new THREE.BufferAttribute(pos.array, 3));
    if (prim.attributes.NORMAL !== undefined) geo.setAttribute('normal', new THREE.BufferAttribute(read(prim.attributes.NORMAL).array, 3));
    else geo.computeVertexNormals();
    if (prim.attributes.COLOR_0 !== undefined) {
      const c = read(prim.attributes.COLOR_0);
      const rgb = new Float32Array((c.array.length / c.size) * 3);
      for (let i = 0; i < rgb.length / 3; i++) for (let k = 0; k < 3; k++) rgb[i * 3 + k] = c.array[i * c.size + k];
      geo.setAttribute('color', new THREE.BufferAttribute(rgb, 3));
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pos.array.length / 3 * 2), 2));
    if (prim.indices !== undefined) geo.setIndex(new THREE.BufferAttribute(new Uint32Array(read(prim.indices).array), 1));
    geo.computeBoundingBox();
    result.set(node.name, geo);
  }
  return result;
}

interface GltfJson {
  nodes: Array<{ name: string; mesh?: number }>;
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number>; indices?: number }> }>;
  accessors: Array<{ bufferView: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }>;
  bufferViews: Array<{ byteOffset?: number; byteLength: number; byteStride?: number }>;
}

/** Registers the pieces of a kit GLB (node tests read app/public/kits/kits.glb from disk). */
export function registerKits(buf: ArrayBuffer): void {
  for (const [name, geo] of parseGlb(buf)) pieces.set(name, geo);
}

/** Fetches and registers the kits once; the city waits on it before its first build. */
let loading: Promise<void> | null = null;
export function loadKits(): Promise<void> {
  // Vite's base URL; the cast keeps this module loadable in node, where tests register the kits from disk.
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  loading ??= fetch(`${base}kits/kits.glb`)
    .then((r) => {
      if (!r.ok) throw new Error(`kits: ${r.status}`);
      return r.arrayBuffer();
    })
    .then(registerKits);
  return loading;
}

let fallback = false;

/** Every plain piece the app builds from: what a stand-in must cover when the kits cannot load. */
const COURSES = ['course_a', 'course_b', 'pier_block', 'band_course'];
const BOXES = ['water_tank', 'tank_cap', 'tank_stand', 'bulkhead', 'penthouse', 'screen_panel', 'rooftop_unit', 'car', 'bay', 'bay_glass', 'chamfer_box', 'round_box', 'deco_fin', 'org_rib', 'arc_pod'];

/**
 * Plain stand-ins for every kit piece, for when kits.glb is missing or
 * corrupt: a course is a flat slab in the course's frame (x -0.5..0.5,
 * y 0..1, face at z 0, 5 cm deep), every roof and massing piece a unit box,
 * and no crowns (each sci-fi family then builds its own top floor). The
 * city stands, plainer, instead of going blank. Leaves real pieces alone.
 */
export function registerFallbackKits(): void {
  fallback = true;
  const white = (g: THREE.BufferGeometry): THREE.BufferGeometry => {
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 3).fill(1), 3));
    g.computeBoundingBox();
    return g;
  };
  for (const c of COURSES) {
    for (const lod of ['hi', 'lo']) {
      const name = `${c}.${lod}`;
      if (!pieces.has(name)) pieces.set(name, white(new THREE.BoxGeometry(1, 1, 0.05).translate(0, 0.5, -0.025)));
    }
  }
  for (const b of BOXES) if (!pieces.has(b)) pieces.set(b, white(new THREE.BoxGeometry(1, 1, 1)));
}

/** True when the city is standing on the plain stand-ins (registerFallbackKits) rather than the Blender kits. */
export function kitsFallback(): boolean {
  return fallback;
}

export function hasKit(name: string): boolean {
  return pieces.has(name);
}

/** A fresh copy of a kit piece (its owner may dispose it). Throws if the kits are not loaded: a build must never silently lose its architecture. */
export function kitPiece(name: string): THREE.BufferGeometry {
  const g = pieces.get(name);
  if (!g) throw new Error(`kit piece ${name} is not loaded (loadKits or registerKits first)`);
  return g.clone();
}

/** The shared kit piece itself, for instanced batches that never dispose their geometry. */
export function kitShared(name: string): THREE.BufferGeometry {
  const g = pieces.get(name);
  if (!g) throw new Error(`kit piece ${name} is not loaded (loadKits or registerKits first)`);
  return g;
}

/** Every crown slot the kit carries for a family, by slot name. */
export function crownSlots(family: string): string[] {
  const out: string[] = [];
  for (const k of pieces.keys()) if (k.startsWith(`crown_${family}.`)) out.push(k.slice(`crown_${family}.`.length));
  return out.sort();
}
