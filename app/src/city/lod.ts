/**
 * What the city draws, where, and in which pass. Pure, so it is tested in Node.
 *
 * - The ambient blocks' roof kit (bulkheads, penthouses, screens, tanks,
 *   rooftop units, cars) and their street lamps' poles draw in full only near
 *   the eye; past AMBIENT_LOD.near they dissolve, by a screen-door dither,
 *   into simple boxes of the same bulk and tone, and past AMBIENT_LOD.far only
 *   the boxes stand. The fade is per part, so it is a ring, not a seam.
 * - Each pass has its own layers (passLayers): the view, the sun's shadow map
 *   and the AO's normal pass. The city-wide batches draw in the view only;
 *   the shadow map takes copies of the blocks in the sun's shadow column
 *   round the camera's target, and the AO takes copies of the blocks within
 *   AO_NEAR of the eye, where it can still show.
 * - A tower's thin repeated parts (mullions, fins, colonnettes, dentils) hide
 *   once they are under half a pixel wide (detailHidden); crowns and window
 *   panes never do.
 */
import * as THREE from 'three';

/** The ambient roof kit's dissolve, in metres from the eye: full kit inside `near`, boxes only past `far`. */
export const AMBIENT_LOD = { near: 450, far: 600 } as const;

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
