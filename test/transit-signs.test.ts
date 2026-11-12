import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';

import { signPlates } from '../app/src/city/sign-plates.js';

// A station sign is read from both sides of the platform: each side must show its lettering the right way round.

test('a sign reads the right way round from in front and from behind', () => {
  const uv: [number, number, number, number] = [0.25, 0.5, 0.75, 0.625];
  for (const face of [{ x: 1, z: 0 }, { x: 0, z: -1 }, { x: Math.SQRT1_2, z: Math.SQRT1_2 }]) {
    const plates = signPlates([10, 3, -4], face, 2, 0.5, uv);
    assert.equal(plates.length, 2, 'a plate each way');
    const seen = new Set<number>();
    for (const g of plates) {
      const p = g.attributes.position;
      const t = g.attributes.uv;
      const n = new THREE.Vector3().fromBufferAttribute(g.attributes.normal, 0);
      // Standing in front of this plate, looking at it: its right is (toward the plate) x up.
      const right = n.clone().negate().cross(new THREE.Vector3(0, 1, 0));
      seen.add(Math.sign(n.dot(new THREE.Vector3(face.x, 0, face.z))));
      // Winding: the face the plate shows is the one its normal points to (drawn front faces only).
      const a = new THREE.Vector3().fromBufferAttribute(p, g.index!.getX(0));
      const b = new THREE.Vector3().fromBufferAttribute(p, g.index!.getX(1));
      const c = new THREE.Vector3().fromBufferAttribute(p, g.index!.getX(2));
      assert.ok(b.clone().sub(a).cross(c.clone().sub(a)).dot(n) > 0, 'wound to face along its normal');
      for (let i = 0; i < p.count; i++) {
        for (let k = 0; k < p.count; k++) {
          const d = new THREE.Vector3().fromBufferAttribute(p, k).sub(new THREE.Vector3().fromBufferAttribute(p, i));
          const du = t.getX(k) - t.getX(i);
          const dv = t.getY(k) - t.getY(i);
          if (Math.abs(d.dot(right)) > 0.1) assert.ok(Math.sign(du) === Math.sign(d.dot(right)), `the lettering runs left to right as seen (face ${JSON.stringify(face)}, normal ${n.toArray().map((x) => x.toFixed(2))})`);
          if (Math.abs(d.y) > 0.1) assert.ok(Math.sign(dv) === Math.sign(d.y), 'and upright');
        }
      }
    }
    assert.deepEqual([...seen].sort(), [-1, 1], 'one plate faces each way');
  }
});
