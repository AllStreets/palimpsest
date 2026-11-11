/**
 * Where a frame's triangles and draw calls go: by subsystem (the ambient
 * blocks, the district towers, the quarters, the exchange, the job sites, the
 * river, the ground) and by pass (the main pass, the shadow map, the AO
 * normal pass, the post chain's own quads). Debug and tests only: it wraps
 * the renderer's renderBufferDirect for one frame when asked, then unwraps.
 */
import * as THREE from 'three';

export type PassName = 'main' | 'shadow' | 'ao' | 'post';
export interface Tally {
  calls: number;
  triangles: number;
}
export type Breakdown = Record<string, Partial<Record<PassName, Tally>>>;

/** Counts one frame, attributing each draw to the first of `roots` above the drawn object (else 'other'). */
export function frameBreakdown(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  roots: () => Array<[string, THREE.Object3D]>,
  drawFrame: () => void,
  /** Splits each subsystem by the drawn mesh's name. */
  detail = false,
): Breakdown {
  const named = new Map<THREE.Object3D, string>();
  for (const [name, o] of roots()) named.set(o, name);
  const out: Breakdown = {};
  const r = renderer as unknown as { renderBufferDirect: (...a: any[]) => void }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const base = r.renderBufferDirect;
  r.renderBufferDirect = function (cam: THREE.Camera, sc: THREE.Scene | null, geometry: unknown, material: unknown, object: THREE.Object3D, group: unknown) {
    const before = renderer.info.render.triangles;
    const calls = renderer.info.render.calls;
    base.call(renderer, cam, sc, geometry, material, object, group);
    let owner = 'other';
    let pass: PassName = 'post';
    let o: THREE.Object3D | null = object;
    let inScene = false;
    while (o) {
      if (owner === 'other' && named.has(o)) owner = named.get(o)!;
      if (o === scene) inScene = true;
      o = o.parent;
    }
    if (inScene) pass = scene.overrideMaterial ? 'ao' : cam !== camera ? 'shadow' : 'main';
    else owner = 'post';
    if (detail && object.name) owner = `${owner}:${object.name}`;
    const t = ((out[owner] ??= {})[pass] ??= { calls: 0, triangles: 0 });
    t.calls += renderer.info.render.calls - calls;
    t.triangles += renderer.info.render.triangles - before;
  };
  try {
    drawFrame();
  } finally {
    r.renderBufferDirect = base;
  }
  return out;
}
