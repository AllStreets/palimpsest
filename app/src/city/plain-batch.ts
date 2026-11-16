/**
 * The district towers' plain meshes drawn across the city in one call per
 * material (and per pass), however many districts stand. Each tower builds
 * one merged mesh per material (kit.ts Kit.build); here those meshes from
 * every tower are laid into world space and merged with the same material's
 * meshes from every other tower, so a seventh district adds no calls for
 * them. Instanced parts (the window panes whose rows light one by one, the
 * kit parts with near and far levels, the thin parts that hide under half a
 * pixel) stay on their tower and draw as they did.
 *
 * Kept incremental: a tower rebuilt or removed re-merges only the materials
 * it drew in. The pieces' own plain meshes stay where they are, hidden, for
 * framing and the next rebuild. Each merged mesh carries its parts' world
 * spheres (`userData.lodParts`), so the city's level-of-detail pass judges
 * the nearest part, not the whole city's span. Each merged mesh is laid out
 * in clusters (batch.ts ClusterMesh), so a pass draws only the clusters its
 * camera sees, still in one call. Pure three.js: tested in Node.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { ClusterMesh } from './batch.js';

interface Part {
  mat: THREE.Material;
  cast: boolean;
  receive: boolean;
  name: string;
  geo: THREE.BufferGeometry;
}

interface Entry {
  parts: Map<string, Part[]>;
}

export interface PlainBatch {
  group: THREE.Group;
  /**
   * Draws the plain meshes of exactly these roots (each already placed in
   * the world): new roots are taken in and their plain meshes hidden, roots
   * no longer listed are let go. `skip` are meshes never taken (pick proxies
   * drawn for picking). Returns true when anything changed.
   */
  set(roots: THREE.Object3D[], skip?: (o: THREE.Object3D) => boolean): boolean;
  dispose(): void;
}

const attrs = (g: THREE.BufferGeometry): string =>
  `${Object.keys(g.attributes)
    .sort()
    .map((k) => `${k}${g.attributes[k].itemSize}`)
    .join(',')}`;

/** Every piece indexed (an unindexed one gets one index per vertex), so indexed and unindexed pieces merge alike. */
function indexed(g: THREE.BufferGeometry): THREE.BufferGeometry {
  if (!g.index) {
    const n = g.attributes.position.count;
    const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return g;
}

export function plainBatch(): PlainBatch {
  const group = new THREE.Group();
  group.name = 'district-plains';
  const entries = new Map<THREE.Object3D, Entry>();
  const drawn = new Map<string, THREE.Mesh[]>();

  function take(root: THREE.Object3D, skip?: (o: THREE.Object3D) => boolean): Entry {
    root.updateMatrixWorld(true);
    const parts = new Map<string, Part[]>();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || !mesh.visible || skip?.(o)) return;
      // Only a mesh drawn whenever its tower is (no LOD level, nothing hidden above it) is taken.
      for (let p = o.parent; p && p !== root; p = p.parent) if (!p.visible || (p as THREE.LOD).isLOD) return;
      const mat = mesh.material;
      if (Array.isArray(mat)) return;
      const geo = indexed(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
      geo.computeBoundingSphere();
      const key = `${mat.uuid}|${mesh.castShadow}|${mesh.receiveShadow}|${attrs(geo)}`;
      let list = parts.get(key);
      if (!list) parts.set(key, (list = []));
      list.push({ mat, cast: mesh.castShadow, receive: mesh.receiveShadow, name: mesh.name, geo });
      mesh.visible = false;
    });
    return { parts };
  }

  function remerge(key: string): void {
    for (const m of drawn.get(key) ?? []) {
      group.remove(m);
      if (m.userData.ownGeometry) m.geometry.dispose();
    }
    drawn.delete(key);
    const all: Part[] = [];
    for (const e of entries.values()) all.push(...(e.parts.get(key) ?? []));
    if (all.length === 0) return;
    const first = all[0];
    const merged = all.length === 1 ? null : mergeGeometries(all.map((p) => p.geo), false);
    // Pieces whose attributes do not line up draw on their own rather than being lost.
    const out: Array<{ geo: THREE.BufferGeometry; own: boolean; spheres: THREE.Sphere[] }> = merged
      ? [{ geo: merged, own: true, spheres: all.map((p) => p.geo.boundingSphere!) }]
      : all.map((p) => ({ geo: p.geo, own: false, spheres: [p.geo.boundingSphere!] }));
    const meshes: THREE.Mesh[] = [];
    for (const o of out) {
      o.geo.computeBoundingSphere();
      // Laid out in clusters, so a close view draws only the towers it sees (batch.ts). A piece drawn on its own is
      // shared with its tower's taking (`own` false): its clusters reorder only its triangles, which draw the same.
      const mesh = new ClusterMesh(o.geo, first.mat);
      mesh.castShadow = first.cast;
      mesh.receiveShadow = first.receive;
      mesh.name = first.name;
      mesh.userData.ownGeometry = o.own;
      mesh.userData.lodParts = o.spheres;
      group.add(mesh);
      meshes.push(mesh);
    }
    drawn.set(key, meshes);
  }

  return {
    group,
    set(roots, skip) {
      const want = new Set(roots);
      const dirty = new Set<string>();
      for (const [root, e] of entries) {
        if (want.has(root)) continue;
        for (const [key, list] of e.parts) {
          dirty.add(key);
          for (const p of list) p.geo.dispose();
        }
        entries.delete(root);
      }
      for (const root of roots) {
        if (entries.has(root)) continue;
        const e = take(root, skip);
        entries.set(root, e);
        for (const key of e.parts.keys()) dirty.add(key);
      }
      for (const key of dirty) remerge(key);
      return dirty.size > 0;
    },
    dispose() {
      for (const list of drawn.values()) for (const m of list) if (m.userData.ownGeometry) m.geometry.dispose();
      for (const e of entries.values()) for (const list of e.parts.values()) for (const p of list) p.geo.dispose();
      drawn.clear();
      entries.clear();
      group.clear();
    },
  };
}
