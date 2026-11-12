import * as THREE from 'three';

type V2 = { x: number; z: number };
type V3 = [number, number, number];

/**
 * A sign's two plates, back to back, w by h, centred at p: one facing along
 * `face` (a unit vector in the ground plane), one facing away, each reading
 * the atlas rectangle the right way round from its own side (a single
 * double-sided plate reads mirrored from behind). In world space.
 */
export function signPlates(p: V3, face: V2, w: number, h: number, uv: [number, number, number, number]): THREE.BufferGeometry[] {
  return [1, -1].map((k) => {
    const g = new THREE.PlaneGeometry(w, h);
    const a = g.attributes.uv as THREE.BufferAttribute;
    for (let i = 0; i < a.count; i++) a.setXY(i, a.getX(i) ? uv[2] : uv[0], a.getY(i) ? uv[3] : uv[1]);
    g.rotateY(Math.atan2(k * face.x, k * face.z));
    g.translate(p[0], p[1], p[2]);
    return g;
  });
}
