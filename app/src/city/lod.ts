/**
 * What the city draws, where, and in which pass. Pure, so it is tested in Node.
 *
 * - The ambient blocks' roof kit (bulkheads, penthouses, screens, tanks,
 *   rooftop units, cars) and their street lamps' poles draw in full only near
 *   the eye; past AMBIENT_LOD.near they dissolve, by a screen-door dither,
 *   into simple boxes of the same bulk and tone, and past AMBIENT_LOD.far only
 *   the boxes stand. The fade is per part, so it is a ring, not a seam.
 * - Each pass has its own layers (passLayers): the view, the sun's shadow map
 *   and the AO's normal pass. The city-wide batches draw in the view only,
 *   through copies of the blocks the eye's frustum meets (frustumBlocks);
 *   the shadow map takes copies of the blocks in the sun's shadow column
 *   round the camera's target, and the AO takes copies of the blocks within
 *   AO_NEAR of the eye, where it can still show, that the frustum meets.
 * - A tower's thin repeated parts (mullions, fins, colonnettes, dentils) hide
 *   once they are under half a pixel wide (detailHidden); crowns and window
 *   panes never do.
 */
import * as THREE from 'three';

/** The ambient roof kit's dissolve, in metres from the eye: full kit inside `near`, boxes only past `far`. */
export const AMBIENT_LOD = { near: 450, far: 600 } as const;

/**
 * A tower kit part's two levels (tower/kit.ts LOD_FAR, 450 m from the part):
 * the near level dissolves into the far one across this band, by the same
 * screen-door pattern as the roof kit, each instance by its own distance
 * from the eye, so the switch never pops (Task 15).
 */
export const TOWER_LOD = { near: 430, far: 470 } as const;

/** The two levels' shares of a part `d` metres from the eye: complementary, so every part draws whole across the band. */
export function towerLodBlend(d: number): { near: number; far: number } {
  const far = lodFade(d, TOWER_LOD.near, TOWER_LOD.far);
  return { near: 1 - far, far };
}

const lodEye = new THREE.Vector3();
const lodAt = new THREE.Vector3();
/**
 * An LOD of two levels that cross-fade (TOWER_LOD) rather than switch: both
 * levels stand while any of its instances is inside the band (`reach` is how
 * far its instances spread round its centre), and the shaders (lod-shader.ts
 * towerLodMaterial) give each pixel to one of them.
 */
export class FadeLOD extends THREE.LOD {
  /** How far the instances stand from the LOD's centre, at most, in metres. */
  reach = 0;
  override update(camera: THREE.Camera): void {
    const levels = this.levels;
    // Two levels of one geometry (a kit part at medium) look the same either side: a plain switch, drawn once.
    const shape = (k: number): THREE.BufferGeometry | undefined => (levels[k]?.object as THREE.Mesh | undefined)?.geometry;
    if (levels.length < 2 || (shape(0) !== undefined && shape(0) === shape(1))) {
      super.update(camera);
      return;
    }
    lodEye.setFromMatrixPosition(camera.matrixWorld);
    lodAt.setFromMatrixPosition(this.matrixWorld);
    const d = lodEye.distanceTo(lodAt) / ((camera as THREE.PerspectiveCamera).zoom ?? 1);
    const near = d < TOWER_LOD.far + this.reach;
    const far = d > TOWER_LOD.near - this.reach;
    levels[0].object.visible = near;
    levels[1].object.visible = far;
    (this as unknown as { _currentLevel: number })._currentLevel = near ? 0 : 1;
  }
}

/** The greatest distance of any instance of these meshes (their instance matrices, in the LOD's frame) from the LOD's centre. */
export function instanceReach(meshes: THREE.InstancedMesh[]): number {
  // Straight off the matrices' translation columns: it runs inside a rebuild step, once per LOD (Task 13's budget).
  let r2 = 0;
  for (const mesh of meshes) {
    const a = mesh.instanceMatrix.array;
    const { x, y, z } = mesh.position;
    for (let i = 0, o = 12; i < mesh.count; i++, o += 16) {
      const dx = a[o] + x;
      const dy = a[o + 1] + y;
      const dz = a[o + 2] + z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > r2) r2 = d2;
    }
  }
  return Math.sqrt(r2);
}

/**
 * Past this distance from the eye nothing joins the AO pass. GTAO fades out
 * by 1200 m from the eye (post.ts AO_FADE_END, measured as distance, not
 * depth, so the same across the frame): nothing that could show any AO is
 * left out.
 */
export const AO_NEAR = 1250;

/** Layers past the default (0, which every pass draws): what only the view, only the shadow map or only the AO draws. */
export const LAYER = { view: 1, shadow: 2, ao: 3 } as const;

/** The layers each pass's camera sees. */
export function passLayers(): { view: THREE.Layers; shadow: THREE.Layers; ao: THREE.Layers } {
  const of = (extra: number): THREE.Layers => {
    const l = new THREE.Layers();
    l.set(0);
    l.enable(extra);
    return l;
  };
  return { view: of(LAYER.view), shadow: of(LAYER.shadow), ao: of(LAYER.ao) };
}

/** Sets an object's layers to exactly these. */
export function setLayers(o: THREE.Object3D, ...layers: number[]): void {
  o.layers.disableAll();
  for (const l of layers) o.layers.enable(l);
}

/** How far into the far level a part at distance d stands: 0 near, 1 far (the shader's smoothstep). */
export function lodFade(d: number, near: number = AMBIENT_LOD.near, far: number = AMBIENT_LOD.far): number {
  const t = Math.min(1, Math.max(0, (d - near) / (far - near)));
  return t * t * (3 - 2 * t);
}

/**
 * The view's blocks (Task 12): the city-wide ambient batches draw in the
 * view only the blocks (64 m of building in an 80 m cell, their own
 * clusters) the eye's frustum meets, and the AO only those of its near
 * blocks. What is held is widened by a margin (FRUSTUM_MARGIN metres, or
 * FRUSTUM_TURN of the distance past that) so a slow turn or step does not
 * refill each frame: `held` is refilled to the widened set only when the
 * frustum meets a block it lacks, or when it holds well over what the
 * widened set would. Returns true when `held` changed (the copies refill).
 */
export const FRUSTUM_MARGIN = 40;
export const FRUSTUM_TURN = 0.08;
const fBox = new THREE.Box3();
/** Scratch for the widened set, grown as needed: frustumBlocks runs twice a frame. */
let fWide = new Uint8Array(0);
export function frustumBlocks(blocks: ReadonlyArray<BlockBox>, mask: Uint8Array, frustum: THREE.Frustum, eye: { x: number; y: number; z: number }, held: Uint8Array): boolean {
  let missing = false;
  let wide = 0;
  let have = 0;
  if (fWide.length < blocks.length) fWide = new Uint8Array(blocks.length);
  const widened = fWide.subarray(0, blocks.length);
  widened.fill(0);
  for (let k = 0; k < blocks.length; k++) {
    have += held[k];
    if (!mask[k]) continue;
    const b = blocks[k];
    fBox.min.set(b.minX, b.minY, b.minZ);
    fBox.max.set(b.maxX, b.maxY, b.maxZ);
    if (!held[k] && frustum.intersectsBox(fBox)) missing = true;
    const m = Math.max(FRUSTUM_MARGIN, boxDistance(eye, b) * FRUSTUM_TURN);
    fBox.expandByScalar(m);
    if (frustum.intersectsBox(fBox)) {
      widened[k] = 1;
      wide++;
    }
  }
  // Held blocks no longer in the mask (the AO's near set moved) count as too many.
  let stale = false;
  for (let k = 0; k < blocks.length && !stale; k++) if (held[k] && !mask[k]) stale = true;
  if (!missing && !stale && have <= wide * 1.25 + 4) return false;
  held.set(widened);
  return true;
}

/**
 * frustumBlocks without the full refill (Task 13): `held` only ever grows
 * here, by the widened blocks it lacks once the frustum meets one, and those
 * are marked in `added` ('grow': the copies take just them, at their end).
 * When it holds well over what the widened set would, or blocks the mask no
 * longer has, it returns 'shrink' and sets `held` to the widened set, for a
 * refill that may wait (what the copies hold meanwhile is a superset of
 * what is seen). A 'grow' and a 'shrink' together say 'both'.
 */
export function frustumDelta(
  blocks: ReadonlyArray<BlockBox>,
  mask: Uint8Array,
  frustum: THREE.Frustum,
  eye: { x: number; y: number; z: number },
  held: Uint8Array,
  added: Uint8Array,
): 'same' | 'grow' | 'shrink' | 'both' {
  let missing = false;
  let wide = 0;
  let have = 0;
  if (fWide.length < blocks.length) fWide = new Uint8Array(blocks.length);
  const widened = fWide.subarray(0, blocks.length);
  widened.fill(0);
  for (let k = 0; k < blocks.length; k++) {
    have += held[k];
    if (!mask[k]) continue;
    const b = blocks[k];
    fBox.min.set(b.minX, b.minY, b.minZ);
    fBox.max.set(b.maxX, b.maxY, b.maxZ);
    if (!held[k] && frustum.intersectsBox(fBox)) missing = true;
    const m = Math.max(FRUSTUM_MARGIN, boxDistance(eye, b) * FRUSTUM_TURN);
    fBox.expandByScalar(m);
    if (frustum.intersectsBox(fBox)) {
      widened[k] = 1;
      wide++;
    }
  }
  let stale = false;
  for (let k = 0; k < blocks.length && !stale; k++) if (held[k] && !mask[k]) stale = true;
  added.fill(0);
  let grew = false;
  if (missing) {
    for (let k = 0; k < blocks.length; k++) {
      if (widened[k] && !held[k]) {
        added[k] = 1;
        held[k] = 1;
        have++;
        grew = true;
      }
    }
  }
  const shrink = stale || have > wide * 1.25 + 4;
  if (shrink) held.set(widened);
  return grew ? (shrink ? 'both' : 'grow') : shrink ? 'shrink' : 'same';
}

/** While the eye moves, the sun's shadow box follows it in steps of this many metres (scene.ts followShadow, Task 13). */
export const SHADOW_STEP = 48;
/** And comes to rest where the eye stopped once it has stood this long, in seconds. */
export const SHADOW_REST = 0.2;
/**
 * Whether the shadow box moves to the eye's texel-snapped centre this frame
 * (and the shadow map is redrawn): `from` is how far that centre is from the
 * box's (NaN before the first frame), `still` how long the eye has stood.
 */
export function shadowBoxMoves(from: number, still: number): boolean {
  if (from === 0) return false;
  return !(from <= SHADOW_STEP) || still >= SHADOW_REST;
}

/** An axis-aligned box: a block with whatever stands on it. */
export interface BlockBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

/** Distance from a point to a box's nearest point (zero inside). */
export function boxDistance(p: { x: number; y: number; z: number }, b: BlockBox): number {
  const dx = Math.max(b.minX - p.x, 0, p.x - b.maxX);
  const dy = Math.max(b.minY - p.y, 0, p.y - b.maxY);
  const dz = Math.max(b.minZ - p.z, 0, p.z - b.maxZ);
  return Math.hypot(dx, dy, dz);
}

/** The indices of the blocks that pass. */
export function selectBlocks(blocks: ReadonlyArray<BlockBox>, keep: (b: BlockBox) => boolean): number[] {
  const out: number[] = [];
  for (let k = 0; k < blocks.length; k++) if (keep(blocks[k])) out.push(k);
  return out;
}

/**
 * The sun's shadow camera as scene.ts places it: an orthographic box `half`
 * either side of the target across the light, looking down the sun's
 * direction from `offset` metres up it, `near` to `far` deep. Returns a test
 * for a block: does any of it stand inside that box, where it can throw a
 * shadow into the map? (three culls each mesh against the same box; this
 * picks which blocks the shadow copies carry.)
 */
export function shadowColumn(
  sunDir: THREE.Vector3,
  target: { x: number; y: number; z: number },
  o: { half: number; offset: number; near: number; far: number },
): (b: BlockBox) => boolean {
  const s = sunDir.clone().normalize();
  // The light camera's axes: three's lookAt from the sun toward the target.
  const m = new THREE.Matrix4().lookAt(s.clone().multiplyScalar(o.offset), new THREE.Vector3(), new THREE.Vector3(0, 1, 0));
  const u = new THREE.Vector3().setFromMatrixColumn(m, 0);
  const v = new THREE.Vector3().setFromMatrixColumn(m, 1);
  const c = new THREE.Vector3();
  return (b) => {
    c.set((b.minX + b.maxX) / 2 - target.x, (b.minY + b.maxY) / 2 - target.y, (b.minZ + b.maxZ) / 2 - target.z);
    const r = Math.hypot(b.maxX - b.minX, b.maxY - b.minY, b.maxZ - b.minZ) / 2;
    if (Math.abs(c.dot(u)) > o.half + r || Math.abs(c.dot(v)) > o.half + r) return false;
    // Depth along the light from the sun: the sun stands `offset` up the sun's direction from the target.
    const depth = o.offset - c.dot(s);
    return depth + r > o.near && depth - r < o.far;
  };
}

/** The ambient city's far form (Task 7, facade.ts): it fades in from `near` and is whole by `full`, metres from the eye. */
export const FAR_FORM = { near: 420, full: 1300 } as const;

/** Under this many pixels wide a tower's thin repeated part hides; it comes back over SHOW_PX. */
export const HIDE_PX = 0.5;
export const SHOW_PX = 0.6;

/**
 * Whether a tower's thin repeated part (smallest world size `size` metres,
 * nearest point `distance` from the eye) is hidden this frame, given whether
 * it was hidden last time: the app's 36 degree lens over a view `viewHeight`
 * pixels tall, with a band so a camera at the edge never flickers it.
 */
export function detailHidden(o: { size: number; distance: number; hidden: boolean; viewHeight: number; fov?: number }): boolean {
  const fov = ((o.fov ?? 36) * Math.PI) / 180;
  const px = (o.size * o.viewHeight) / (2 * Math.max(o.distance, 1e-3) * Math.tan(fov / 2));
  return o.hidden ? px < SHOW_PX : px < HIDE_PX;
}
