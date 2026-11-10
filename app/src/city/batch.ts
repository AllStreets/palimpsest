/**
 * Draws many built pieces in few calls (the firms' quarters): every drawn
 * mesh under the given roots is gathered by what it is drawn in and merged
 * into one batch per kind, across all the roots at once.
 *
 * - A plain mesh merges, in world space, with every other plain mesh in the
 *   same material (and the same shadow flags and attributes).
 * - A small instanced part whose colour is only a tint the material reads
 *   as a vertex colour is laid out instance by instance (its colour baked
 *   into its vertices) and merges with the plain meshes in its material.
 * - Any other instanced part joins every other instance of the same shape
 *   in the same material: one InstancedMesh with each instance's world
 *   matrix and colour, so instance data is kept. A material that reads its
 *   instance matrix as data (the window shader's rooms) says so with
 *   `userData.instanceData`, and its parts always stay instanced.
 * - A part with a near and a far level (Kit.instLod) joins the same shape
 *   in the same material within its own root, under one LOD centred on that
 *   root, so the switch still follows each quarter rather than the city.
 *
 * Every world position and every instance matrix comes out as it went in,
 * so the shaders (which read world positions and instance matrices) draw
 * exactly what the pieces drew. Pieces stay where they are, hidden, for
 * picking and for the next rebuild; meshes with `visible` false (pick
 * proxies) are never drawn and never merged. Pure three.js: tested in Node.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export interface Batched {
  group: THREE.Group;
  dispose(): void;
}

/** A shape's identity by content, so the same part built by two kits batches together. */
const prints = new WeakMap<THREE.BufferGeometry, string>();
function fingerprint(g: THREE.BufferGeometry): string {
  let p = prints.get(g);
  if (p) return p;
  const pos = g.attributes.position as THREE.BufferAttribute;
  let h = 0;
  const a = pos.array as ArrayLike<number>;
  for (let i = 0; i < a.length; i++) h = (h * 31 + Math.round(a[i] * 1000)) | 0;
  const idx = g.index ? g.index.count : -1;
  p = `${Object.keys(g.attributes).sort().join(',')}|${pos.count}|${idx}|${h}`;
  prints.set(g, p);
  return p;
}

/** Instanced parts with more vertices than this in all stay instanced rather than being laid out. */
const EXPAND_LIMIT = 24000;

/** Each instance of `im` as its own geometry in world space, its instance colour multiplied into its vertex colours. */
function expand(im: THREE.InstancedMesh, world: THREE.Matrix4): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  for (let i = 0; i < im.count; i++) {
    im.getMatrixAt(i, m);
    const g = im.geometry.clone().applyMatrix4(m.premultiply(world));
    if (im.instanceColor) {
      im.getColorAt(i, c);
      const col = g.attributes.color as THREE.BufferAttribute;
      for (let v = 0; v < col.count; v++) col.setXYZ(v, col.getX(v) * c.r, col.getY(v) * c.g, col.getZ(v) * c.b);
    }
    out.push(g);
  }
  return out;
}

/** The tower window glass draws each pane's room from its instance matrix (look.ts windowMaterial). */
const WINDOW_PROGRAM = 'palimpsest-tower-window';
function readsInstance(mat: THREE.Material): boolean {
  // Matched by prefix: the city's searchlight pass suffixes the key (searchlight.ts).
  return !!mat.userData.instanceData || mat.customProgramCacheKey().startsWith(WINDOW_PROGRAM);
}

/** True when `im` can be laid out as plain geometry and draw the same: see expand. */
function expandable(im: THREE.InstancedMesh): boolean {
  const mat = im.material as THREE.Material & { vertexColors?: boolean };
  if (readsInstance(mat) || !im.geometry.attributes.color) return false;
  if (im.count * im.geometry.attributes.position.count > EXPAND_LIMIT) return false;
  if (mat.vertexColors) return true;
  // Without vertex colours the material would drop the tint: only an untinted part may be laid out.
  if (!im.instanceColor) return true;
  const c = new THREE.Color();
  for (let i = 0; i < im.count; i++) if ((im.getColorAt(i, c), c.r !== 1 || c.g !== 1 || c.b !== 1)) return false;
  return true;
}

const attrs = (g: THREE.BufferGeometry): string => `${Object.keys(g.attributes).sort().join(',')}|${g.index ? 'i' : 'n'}`;

interface Inst {
  mesh: THREE.InstancedMesh;
  world: THREE.Matrix4;
}

/** One InstancedMesh holding every instance of the given meshes (same shape, same material), `shift` applied first. */
function combine(list: Inst[], shift?: THREE.Matrix4): THREE.InstancedMesh {
  const first = list[0].mesh;
  const total = list.reduce((n, l) => n + l.mesh.count, 0);
  const out = new THREE.InstancedMesh(first.geometry, first.material, total);
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  const coloured = list.some((l) => l.mesh.instanceColor);
  let k = 0;
  for (const { mesh, world } of list) {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      m.premultiply(world);
      if (shift) m.premultiply(shift);
      out.setMatrixAt(k, m);
      if (coloured) out.setColorAt(k, mesh.instanceColor ? (mesh.getColorAt(i, c), c) : c.setRGB(1, 1, 1));
      k++;
    }
  }
  out.instanceMatrix.needsUpdate = true;
  if (out.instanceColor) out.instanceColor.needsUpdate = true;
  out.castShadow = first.castShadow;
  out.receiveShadow = first.receiveShadow;
  out.name = first.name;
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/** An unindexed piece as an indexed one (each vertex its own index), so it merges with indexed pieces in its material. */
function indexed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.index) g.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i));
  return g;
}

/** Merges every drawn mesh under `roots` (each already placed in the world) into batches; see above. */
export function batchPieces(roots: THREE.Object3D[]): Batched {
  const group = new THREE.Group();
  group.name = 'batched';
  const plain = new Map<string, { mat: THREE.Material; cast: boolean; receive: boolean; geos: THREE.BufferGeometry[] }>();
  const inst = new Map<string, Inst[]>();
  const owned: THREE.BufferGeometry[] = [];
  const meshes: THREE.InstancedMesh[] = [];

  for (const root of roots) {
    root.updateMatrixWorld(true);
    const lods = new Map<string, { near: Inst[]; far: Inst[]; distance: number }>();
    const visit = (o: THREE.Object3D): void => {
      if ((o as THREE.LOD).isLOD) {
        const lod = o as THREE.LOD;
        const [near, far] = lod.levels;
        const n = near.object as THREE.InstancedMesh;
        const f = far?.object as THREE.InstancedMesh | undefined;
        if (!n?.isInstancedMesh || !f?.isInstancedMesh) {
          lod.children.forEach(visit);
          return;
        }
        const key = `${(n.material as THREE.Material).uuid}|${fingerprint(n.geometry)}|${fingerprint(f.geometry)}|${n.castShadow}|${!!n.instanceColor}|${far.distance}`;
        let b = lods.get(key);
        if (!b) lods.set(key, (b = { near: [], far: [], distance: far.distance }));
        b.near.push({ mesh: n, world: n.matrixWorld.clone() });
        b.far.push({ mesh: f, world: f.matrixWorld.clone() });
        return;
      }
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        // Pick proxies and anything else not drawn.
        if (!mesh.visible) return;
        const mat = mesh.material as THREE.Material;
        if ((mesh as THREE.InstancedMesh).isInstancedMesh && expandable(mesh as THREE.InstancedMesh)) {
          const im = mesh as THREE.InstancedMesh;
          for (const g of expand(im, im.matrixWorld).map(indexed)) {
            const key = `${mat.uuid}|${im.castShadow}|${im.receiveShadow}|${attrs(g)}`;
            let b = plain.get(key);
            if (!b) plain.set(key, (b = { mat, cast: im.castShadow, receive: im.receiveShadow, geos: [] }));
            b.geos.push(g);
          }
        } else if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
          const im = mesh as THREE.InstancedMesh;
          const key = `${mat.uuid}|${fingerprint(im.geometry)}|${im.castShadow}|${im.receiveShadow}|${!!im.instanceColor}`;
          let l = inst.get(key);
          if (!l) inst.set(key, (l = []));
          l.push({ mesh: im, world: im.matrixWorld.clone() });
        } else {
          const g = indexed(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
          const key = `${mat.uuid}|${mesh.castShadow}|${mesh.receiveShadow}|${attrs(g)}`;
          let b = plain.get(key);
          if (!b) plain.set(key, (b = { mat, cast: mesh.castShadow, receive: mesh.receiveShadow, geos: [] }));
          b.geos.push(g);
        }
      }
      o.children.forEach(visit);
    };
    visit(root);

    // Near and far levels share one centre per root, so the switch follows the quarter, not the city.
    const centre = new THREE.Box3().setFromObject(root, false).getCenter(new THREE.Vector3());
    const shift = new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z);
    for (const b of lods.values()) {
      const lod = new THREE.LOD();
      lod.position.copy(centre);
      const near = combine(b.near, shift);
      const far = combine(b.far, shift);
      far.castShadow = false;
      lod.addLevel(near, 0);
      lod.addLevel(far, b.distance);
      meshes.push(near, far);
      group.add(lod);
    }
  }

  for (const b of plain.values()) {
    const g = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
    // Pieces whose attributes do not line up are drawn as they were rather than lost.
    const parts = g ? [g] : b.geos;
    if (g && g !== b.geos[0]) for (const piece of b.geos) piece.dispose();
    for (const part of parts) {
      part.computeBoundingSphere();
      owned.push(part);
      const mesh = new THREE.Mesh(part, b.mat);
      mesh.castShadow = b.cast;
      mesh.receiveShadow = b.receive;
      group.add(mesh);
    }
  }
  for (const list of inst.values()) {
    const m = combine(list);
    meshes.push(m);
    group.add(m);
  }

  return {
    group,
    dispose() {
      for (const g of owned) g.dispose();
      for (const m of meshes) m.dispose();
    },
  };
}

/** What a scene of these roots costs to draw: meshes drawn, an LOD counting one level. */
export function drawnMeshes(root: THREE.Object3D): number {
  let n = 0;
  const visit = (o: THREE.Object3D): void => {
    if ((o as THREE.LOD).isLOD) {
      n += 1;
      return;
    }
    if ((o as THREE.Mesh).isMesh && o.visible) n++;
    if (o.visible) o.children.forEach(visit);
  };
  visit(root);
  return n;
}
