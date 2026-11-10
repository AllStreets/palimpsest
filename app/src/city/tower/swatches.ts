import * as THREE from 'three';

import type { Era, Floor, TowerSpec } from '../../../../shared/types';
import { buildTower } from './build';
import { towerMaterials } from './look';
import { lookFor, VARIANTS } from './variants';

/**
 * A measuring board for the variants: one short tower per variant, eight
 * floors of that era each, floated clear of the city at the overview's own
 * distance and bearing, so their faces take the real dusk key light, sky,
 * haze, tone mapping and post. tools/capture.ts (the `swatches` shot) reads
 * each tower's sunlit and shaded face from a screenshot and writes their
 * Lab colours to rendered.ts, which the picker steers neighbours apart by.
 */

/** The overview's eye relative to what it looks at (tools/capture.ts OVERVIEW). */
const OVERVIEW_OFFSET = new THREE.Vector3(580, 310, 960);
/** Where the board stands: off the districts, over the ambient city, at the overview's distance from its own eye. */
const CENTRE = new THREE.Vector3(-900, 0, -700);
const SPACING = 52;
const ROWS = [118, 196];

export interface SwatchPoint {
  id: string;
  /** CSS pixel centres of the +z face (half sunlit at dusk) and the +x face (in shade), as the overview sees them. */
  sun: [number, number];
  shade: [number, number];
}

function spec(id: string, era: Era): TowerSpec {
  const floors: Floor[] = Array.from({ length: 8 }, (_, i) => ({
    id: `swatch/${id}#${i}`,
    repo: 'swatch/board',
    kind: 'commits',
    refs: [],
    title: '',
    at: new Date(Date.UTC(2024, 0, 1)).toISOString(),
    era,
    size: 'medium',
    lines: 0,
    claude: false,
    founding: true,
    url: null,
  }));
  return { id: `swatch/${id}`, repo: 'swatch/board', kind: 'founding', root: 'chicago', floors, datumIndex: 0 };
}

export function swatchBoard(scene: THREE.Scene, camera: THREE.PerspectiveCamera, view: (eye: THREE.Vector3, target: THREE.Vector3) => void): { points(width: number, height: number): SwatchPoint[]; dispose(): void } {
  const group = new THREE.Group();
  group.name = 'swatch-board';
  const all = Object.values(VARIANTS).flat();
  const perRow = Math.ceil(all.length / ROWS.length);
  const eye = CENTRE.clone().add(new THREE.Vector3(0, 150, 0)).add(OVERVIEW_OFFSET);
  const target = CENTRE.clone().add(new THREE.Vector3(0, 150, 0));
  const d = new THREE.Vector3(target.x - eye.x, 0, target.z - eye.z).normalize();
  const across = new THREE.Vector3(-d.z, 0, d.x);
  const samples: Array<{ id: string; sun: THREE.Vector3; shade: THREE.Vector3 }> = [];
  const disposers: Array<() => void> = [];
  all.forEach((v, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    const base = CENTRE.clone().addScaledVector(across, (col - (perRow - 1) / 2) * SPACING);
    const look = { ...lookFor('swatch/board'), [v.era]: v };
    const t = buildTower(spec(v.id, v.era), 'high', towerMaterials(look), look);
    // Lifted so its floors stand clear of the ambient city; the root below them is never sampled.
    const lift = ROWS[row];
    t.group.position.set(base.x, lift, base.z);
    t.group.traverse((o) => {
      o.castShadow = false;
    });
    group.add(t.group);
    disposers.push(() => t.dispose());
    // Mid-height of the eight floors (the chicago root is 26 m), just proud of the wall line.
    const y = lift + 26 + 8 * 4.2 * 0.5;
    samples.push({ id: v.id, sun: new THREE.Vector3(base.x, y, base.z + 12.6), shade: new THREE.Vector3(base.x + 12.6, y, base.z) });
  });
  scene.add(group);
  view(eye, target);
  return {
    points(width, height) {
      camera.updateMatrixWorld();
      const px = (p: THREE.Vector3): [number, number] => {
        const q = p.clone().project(camera);
        return [((q.x + 1) / 2) * width, ((1 - q.y) / 2) * height];
      };
      return samples.map((s) => ({ id: s.id, sun: px(s.sun), shade: px(s.shade) }));
    },
    dispose() {
      scene.remove(group);
      for (const fn of disposers) fn();
    },
  };
}
