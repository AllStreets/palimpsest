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
 * - Each merged plain batch is laid out in clusters (ClusterMesh, below), so
 *   a close view draws only the clusters it sees.
 *
 * Every world position and every instance matrix comes out as it went in,
 * so the shaders (which read world positions and instance matrices) draw
 * exactly what the pieces drew. Pieces stay where they are, hidden, for
 * picking and for the next rebuild; meshes with `visible` false (pick
 * proxies) are never drawn and never merged. Pure three.js: tested in Node.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

import { FadeLOD, instanceReach } from './lod.js';
import { finish, type Steps } from './steps.js';

export interface Batched {
  group: THREE.Group;
  dispose(): void;
}

// ---------------------------------------------------------------- clusters (Task 12)
/**
 * A merged batch spans the city, so the renderer's own frustum test (one
 * sphere a mesh) never culls it. Its triangles are laid out instead cell by
 * cell (cubes of CLUSTER_SIZE, by each triangle's centre), each cell a
 * cluster with its own bounds, and each pass draws only the clusters its own
 * camera sees (the view, the shadow map's sun, the AO's normal pass): the
 * visible clusters' index ranges, merged where they touch, go to the GPU in
 * one multi-draw, so a batch stays one draw call however many clusters it
 * holds. The draw goes through three.js's batched path (as BatchedMesh's
 * does) with every batch matrix the identity, so every vertex lands exactly
 * where it did.
 */
export const CLUSTER_SIZE = 64;

export interface Cluster {
  /** The cluster's first index and its index count. */
  start: number;
  count: number;
  /** Its triangles' bounds, in the mesh's own frame. */
  box: THREE.Box3;
}

/** Off for a before-and-after measure (the debug handle's cull(false)): every batch draws whole, as before Task 12. */
let culling = true;
export function setClusterCulling(on: boolean): void {
  culling = on;
}
/** Whether the culling is on (grid.ts reads it for the ambient blocks' view and AO copies). */
export function clusterCulling(): boolean {
  return culling;
}

/**
 * Reorders `g`'s triangles (indexed) cell by cell, cells in x, then z, then y
 * order so neighbours lie near in the index, and returns the clusters in
 * index order.
 */
export function clusterTriangles(g: THREE.BufferGeometry, size = CLUSTER_SIZE): Cluster[] {
  return finish(clusterTrianglesSteps(g, size));
}

/** Triangles sorted into cells and laid out per step (steps.ts): a step every CLUSTER_STEP triangles. */
const CLUSTER_STEP = 30_000;
export function* clusterTrianglesSteps(g: THREE.BufferGeometry, size = CLUSTER_SIZE): Steps<Cluster[]> {
  const index = g.index!;
  const idx = index.array as Uint16Array | Uint32Array;
  const pos = g.attributes.position as THREE.BufferAttribute;
  const tris = idx.length / 3;
  const cells = new Map<number, number[]>();
  const coords = new Map<number, [number, number, number]>();
  for (let t = 0; t < tris; t++) {
    if (t > 0 && t % CLUSTER_STEP === 0) yield;
    const a = idx[t * 3];
    const b = idx[t * 3 + 1];
    const c = idx[t * 3 + 2];
    const ix = Math.floor((pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3 / size);
    const iy = Math.floor((pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3 / size);
    const iz = Math.floor((pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3 / size);
    const key = ((ix + 1024) * 2048 + (iz + 1024)) * 2048 + (iy + 1024);
    let list = cells.get(key);
    if (!list) {
      cells.set(key, (list = []));
      coords.set(key, [ix, iz, iy]);
    }
    list.push(t);
  }
  const keys = [...cells.keys()].sort((p, q) => {
    const a = coords.get(p)!;
    const b = coords.get(q)!;
    return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  });
  const out = new (idx.constructor as Uint32ArrayConstructor)(idx.length);
  const clusters: Cluster[] = [];
  const v = new THREE.Vector3();
  let k = 0;
  let laid = 0;
  for (const key of keys) {
    if (laid > CLUSTER_STEP) {
      laid = 0;
      yield;
    }
    laid += cells.get(key)!.length;
    const start = k;
    const box = new THREE.Box3();
    for (const t of cells.get(key)!) {
      for (let j = 0; j < 3; j++) {
        const vi = idx[t * 3 + j];
        out[k++] = vi;
        box.expandByPoint(v.fromBufferAttribute(pos, vi));
      }
    }
    clusters.push({ start, count: k - start, box });
  }
  g.setIndex(new THREE.BufferAttribute(out, 1));
  return clusters;
}

/** Every batch matrix the identity: one, read for every draw. */
let identityTexture: THREE.DataTexture | null = null;
function identity(): THREE.DataTexture {
  if (!identityTexture) {
    identityTexture = new THREE.DataTexture(new Float32Array(new THREE.Matrix4().elements), 4, 1, THREE.RGBAFormat, THREE.FloatType);
    identityTexture.needsUpdate = true;
  }
  return identityTexture;
}
/** Every draw's batch id 0 (the identity), for up to the square of its side draws; shared and grown as needed. */
let idsTexture: THREE.DataTexture | null = null;
function ids(n: number): THREE.DataTexture {
  if (!idsTexture || idsTexture.image.width * idsTexture.image.width < n) {
    const side = Math.max(16, Math.ceil(Math.sqrt(n)));
    idsTexture = new THREE.DataTexture(new Uint32Array(side * side), side, side, THREE.RedIntegerFormat, THREE.UnsignedIntType);
    idsTexture.needsUpdate = true;
  }
  return idsTexture;
}

const cullMatrix = new THREE.Matrix4();
const cullFrustum = new THREE.Frustum();

/**
 * A merged batch laid out in clusters (see above). It draws through the
 * renderer's batched path: `isBatchedMesh` asks for it, and the fields below
 * are the ones that path reads.
 */
export class ClusterMesh extends THREE.Mesh {
  readonly isBatchedMesh = true;
  readonly clusters: Cluster[];
  _multiDrawStarts: Int32Array;
  _multiDrawCounts: Int32Array;
  _multiDrawCount = 0;
  _matricesTexture: THREE.DataTexture;
  _indirectTexture: THREE.DataTexture;
  _colorsTexture = null;

  /** `clusters` when the geometry was already laid out (clusterTrianglesSteps, a batch built a step at a time). */
  constructor(geometry: THREE.BufferGeometry, material: THREE.Material, size = CLUSTER_SIZE, clusters?: Cluster[]) {
    super(geometry, material);
    this.clusters = clusters ?? clusterTriangles(geometry, size);
    this._multiDrawStarts = new Int32Array(this.clusters.length);
    this._multiDrawCounts = new Int32Array(this.clusters.length);
    this._matricesTexture = identity();
    this._indirectTexture = ids(this.clusters.length);
  }

  /**
   * Writes the index ranges of the clusters `camera` sees, in index order and merged where they touch, into
   * `starts` and `counts` (each start times `scale`), and returns how many: no allocation, for every pass.
   */
  private rangesInto(camera: THREE.Camera, starts: Int32Array, counts: Int32Array, scale: number): number {
    if (!culling) {
      if (this.clusters.length === 0) return 0;
      starts[0] = 0;
      counts[0] = this.geometry.index!.count;
      return 1;
    }
    const cam = camera as THREE.Camera & { reversedDepth?: boolean };
    cullMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.matrixWorld);
    cullFrustum.setFromProjectionMatrix(cullMatrix, camera.coordinateSystem, cam.reversedDepth);
    let n = 0;
    let end = -1;
    for (const c of this.clusters) {
      if (!cullFrustum.intersectsBox(c.box)) continue;
      if (n > 0 && end === c.start) counts[n - 1] += c.count;
      else {
        starts[n] = c.start * scale;
        counts[n] = c.count;
        n++;
      }
      end = c.start + c.count;
    }
    return n;
  }

  /** The index ranges of the clusters `camera` sees, in index order, merged where they touch (tests and debugging). */
  visibleRanges(camera: THREE.Camera): Array<[number, number]> {
    const starts = new Int32Array(this.clusters.length + 1);
    const counts = new Int32Array(this.clusters.length + 1);
    const n = this.rangesInto(camera, starts, counts, 1);
    return Array.from({ length: n }, (_, i): [number, number] => [starts[i], counts[i]]);
  }

  /** Lays out the multi-draw list for a draw seen by `camera`. */
  private drawFor(camera: THREE.Camera): void {
    const bytes = (this.geometry.index!.array as Uint16Array | Uint32Array).BYTES_PER_ELEMENT;
    this._multiDrawCount = this.rangesInto(camera, this._multiDrawStarts, this._multiDrawCounts, bytes);
  }

  onBeforeRender(_r: THREE.WebGLRenderer, _s: THREE.Scene, camera: THREE.Camera): void {
    this.drawFor(camera);
  }

  onBeforeShadow(_r: THREE.WebGLRenderer, _s: THREE.Scene, _c: THREE.Camera, shadowCamera: THREE.Camera): void {
    this.drawFor(shadowCamera);
  }
}

// ---------------------------------------------------------------- re-merges spread over frames (Task 13)
/**
 * The city's rebuilds (a floor landing, a quarter's hires, a re-clad) merge
 * many pieces at once. Done in the frame that asked, one such merge can
 * stall it for hundreds of milliseconds. Instead each goes into a queue by
 * key and the city's loop runs the queue for at most REMERGE_BUDGET_MS of
 * each frame. A key queued again replaces its waiting work (and goes to the
 * back of the line), so a burst merges once. A piece of work that returns
 * true has more to do: it stays first in line and goes on while the frame
 * has time left, and next frame if not. The budget is checked before each
 * step: no step starts once 4 ms are spent, so a frame's share is 4 ms plus
 * at most one step, and the builders yield often enough to keep that small.
 * Keys are scoped by owner (`remergeOwner`), so a city or a grid that is
 * disposed takes its own waiting work with it (cancelRemerges).
 */
export const REMERGE_BUDGET_MS = 4;

export interface RemergeQueue {
  schedule(key: string, work: () => void | boolean): void;
  /** Runs waiting work until the frame's budget is spent (the queue's own, or `budget` ms); returns how many pieces ran. */
  run(budget?: number): number;
  pending(): number;
  /** Runs everything waiting now, whatever it costs (a teardown, or a test that wants the result). */
  flush(): void;
  /** The longest single piece of work since last asked, and its key (the perf tools' hitch hunt). */
  longest(): { key: string; ms: number };
  /** Drops every waiting piece of work whose key starts with `prefix` (an owner's, when it is disposed). */
  cancel(prefix: string): number;
}

export function remergeQueue(budgetMs = REMERGE_BUDGET_MS, now: () => number = () => performance.now()): RemergeQueue {
  const queue = new Map<string, () => void | boolean>();
  const step = (): boolean => {
    const [key, work] = queue.entries().next().value as [string, () => void | boolean];
    queue.delete(key);
    const t0 = now();
    const more = work() === true;
    const ms = now() - t0;
    // What a step of this work has lately cost, eased toward each new step (a frame does not start one it cannot fit).
    cost.set(key, Math.max(ms, (cost.get(key) ?? 0) * 0.7));
    if (!more) cost.delete(key);
    if (ms > longest.ms) {
      longest.ms = ms;
      longest.key = key;
    }
    if (more && !queue.has(key)) {
      // Back to the front: the rest of it comes before anything queued behind it.
      const rest = [...queue];
      queue.clear();
      queue.set(key, work);
      for (const [k, w] of rest) queue.set(k, w);
    }
    return true;
  };
  const longest = { key: '', ms: 0 };
  const cost = new Map<string, number>();
  return {
    longest: () => {
      const out = { ...longest };
      longest.ms = 0;
      longest.key = '';
      return out;
    },
    schedule(key, work) {
      queue.delete(key);
      queue.set(key, work);
    },
    run(budget = budgetMs) {
      const start = now();
      let ran = 0;
      // The first step always runs (nothing waits for ever); after it, a step starts only if what such a step has
      // lately cost still fits in what is left of the budget.
      while (queue.size > 0) {
        const spent = now() - start;
        if (spent >= budget) break;
        const next = queue.keys().next().value as string;
        if (ran > 0 && spent + (cost.get(next) ?? 0) > budget) break;
        ran += step() ? 1 : 0;
      }
      return ran;
    },
    pending: () => queue.size,
    cancel(prefix) {
      let n = 0;
      for (const k of [...queue.keys()]) {
        if (!k.startsWith(prefix)) continue;
        queue.delete(k);
        n++;
      }
      return n;
    },
    flush() {
      while (queue.size > 0) step();
    },
  };
}

const remerges = remergeQueue();
/** Queues a re-merge on the city's shared queue (see remergeQueue). */
export function scheduleRemerge(key: string, work: () => void | boolean): void {
  remerges.schedule(key, work);
}
/** Runs the shared queue for this frame's budget (the city's loop, once a frame). */
export function runRemerges(budget?: number): number {
  return remerges.run(budget);
}
/** Drops the waiting re-merges whose keys start with `prefix` (an owner disposed, or work no longer wanted). */
export function cancelRemerges(prefix: string): number {
  return remerges.cancel(prefix);
}
/**
 * The target a rebuild in flight is building toward (Task 13): a request
 * for the same target leaves it to finish rather than starting it again
 * (refreshes come in bursts, each repeating the change still being built).
 */
export function rebuildTarget(): { same(key: string): boolean; start(key: string): void; end(key: string): void; busy(): boolean; current(): string | null } {
  let current: string | null = null;
  return {
    same: (key) => current === key,
    busy: () => current !== null,
    current: () => current,
    start(key) {
      current = key;
    },
    end(key) {
      if (current === key) current = null;
    },
  };
}
let owners = 0;
/** A key prefix of its own for each owner of queued work (a city, a grid), so its jobs never collide with another's. */
export function remergeOwner(kind: string): string {
  owners++;
  return `${kind}#${owners}:`;
}
/** The longest single re-merge step on the shared queue since last asked. */
export function longestRemerge(): { key: string; ms: number } {
  return remerges.longest();
}
/** How many re-merges wait on the shared queue. */
export function pendingRemerges(): number {
  return remerges.pending();
}
/** Runs every waiting re-merge now (tests, and a teardown that must not leave work behind). */
export function flushRemerges(): void {
  remerges.flush();
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
  return finish(expandSteps(im, world));
}
/** expand a few dozen instances a step (steps.ts). */
function* expandSteps(im: THREE.InstancedMesh, world: THREE.Matrix4): Steps<THREE.BufferGeometry[]> {
  const out: THREE.BufferGeometry[] = [];
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  for (let i = 0; i < im.count; i++) {
    if (i > 0 && i % 48 === 0) yield;
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
  return finish(batchPiecesSteps(roots));
}

/** batchPieces a root, then a merged batch, at a time (steps.ts). Hidden roots merge as visible ones do. */
export function* batchPiecesSteps(roots: THREE.Object3D[]): Steps<Batched> {
  const group = new THREE.Group();
  group.name = 'batched';
  const plain = new Map<string, { mat: THREE.Material; cast: boolean; receive: boolean; geos: THREE.BufferGeometry[] }>();
  const inst = new Map<string, Inst[]>();
  const owned: THREE.BufferGeometry[] = [];
  const meshes: THREE.InstancedMesh[] = [];

  let plainSeen = 0;
  for (const root of roots) {
    yield;
    root.updateMatrixWorld(true);
    const lods = new Map<string, { near: Inst[]; far: Inst[]; distance: number }>();
    const visit = function* (o: THREE.Object3D): Steps<void> {
      // Nothing under a hidden object is drawn (a school tower's parts, drawn by their own batch), so none of it merges.
      if (!o.visible && o !== root) return;
      if ((o as THREE.LOD).isLOD) {
        const lod = o as THREE.LOD;
        const [near, far] = lod.levels;
        const n = near.object as THREE.InstancedMesh;
        const f = far?.object as THREE.InstancedMesh | undefined;
        if (!n?.isInstancedMesh || !f?.isInstancedMesh) {
          for (const c of lod.children) yield* visit(c);
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
          for (const g of (yield* expandSteps(im, im.matrixWorld)).map(indexed)) {
            const key = `${mat.uuid}|${im.castShadow}|${im.receiveShadow}|${attrs(g)}`;
            let b = plain.get(key);
            if (!b) plain.set(key, (b = { mat, cast: im.castShadow, receive: im.receiveShadow, geos: [] }));
            b.geos.push(g);
          }
          // Laying out an instanced part instance by instance is the costly part of a merge: a step of its own.
          yield;
        } else if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
          const im = mesh as THREE.InstancedMesh;
          const key = `${mat.uuid}|${fingerprint(im.geometry)}|${im.castShadow}|${im.receiveShadow}|${!!im.instanceColor}`;
          let l = inst.get(key);
          if (!l) inst.set(key, (l = []));
          l.push({ mesh: im, world: im.matrixWorld.clone() });
        } else {
          if (++plainSeen % 12 === 0) yield;
          const g = indexed(mesh.geometry.clone().applyMatrix4(mesh.matrixWorld));
          const key = `${mat.uuid}|${mesh.castShadow}|${mesh.receiveShadow}|${attrs(g)}`;
          let b = plain.get(key);
          if (!b) plain.set(key, (b = { mat, cast: mesh.castShadow, receive: mesh.receiveShadow, geos: [] }));
          b.geos.push(g);
        }
      }
      for (const c of o.children) yield* visit(c);
    };
    yield* visit(root);

    // Near and far levels share one centre per root, so the switch follows the quarter, not the city.
    const centre = new THREE.Box3().setFromObject(root, false).getCenter(new THREE.Vector3());
    const shift = new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z);
    for (const b of lods.values()) {
      // The tower kit's levels cross-fade (lod.ts TOWER_LOD): both stand while any instance is inside the band.
      const lod = new FadeLOD();
      lod.position.copy(centre);
      const near = combine(b.near, shift);
      const far = combine(b.far, shift);
      far.castShadow = false;
      lod.addLevel(near, 0);
      lod.addLevel(far, b.distance);
      lod.reach = instanceReach([near]);
      meshes.push(near, far);
      group.add(lod);
    }
  }

  for (const b of plain.values()) {
    yield;
    const g = b.geos.length === 1 ? b.geos[0] : mergeGeometries(b.geos, false);
    // Pieces whose attributes do not line up are drawn as they were rather than lost.
    const parts = g ? [g] : b.geos;
    if (g && g !== b.geos[0]) for (const piece of b.geos) piece.dispose();
    for (const part of parts) {
      part.computeBoundingSphere();
      owned.push(part);
      // Laid out in clusters, so a close view draws only what it sees (above), a step at a time.
      yield;
      const clusters = yield* clusterTrianglesSteps(part);
      const mesh = new ClusterMesh(part, b.mat, CLUSTER_SIZE, clusters);
      mesh.castShadow = b.cast;
      mesh.receiveShadow = b.receive;
      group.add(mesh);
    }
  }
  for (const list of inst.values()) {
    yield;
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
