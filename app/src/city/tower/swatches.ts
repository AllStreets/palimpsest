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
const SPACING = 40;
/**
 * Two rows of every variant: one lifted so its floors stand at 146 to 180 m,
 * as tall towers' do, and one on the ground so its floors stand at 26 to
 * 60 m, where short towers' do and the street-level darkening and the
 * thickest haze reach. The ambient city is hidden while the board stands, so
 * no block hides the low row.
 */
const ROWS = { high: 120, low: 0 } as const;

export interface SwatchPoint {
  id: string;
  /** CSS pixel centres of the +z face (half sunlit at dusk) and the +x face (in shade), as the overview sees them, high and low. */
  sun: [number, number];
  shade: [number, number];
  sunLow: [number, number];
  shadeLow: [number, number];
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
  const eye = CENTRE.clone().add(new THREE.Vector3(0, 90, 0)).add(OVERVIEW_OFFSET);
  const target = CENTRE.clone().add(new THREE.Vector3(0, 90, 0));
  const d = new THREE.Vector3(target.x - eye.x, 0, target.z - eye.z).normalize();
  const across = new THREE.Vector3(-d.z, 0, d.x);
  const samples: Array<{ id: string; at: Record<'high' | 'low', { sun: THREE.Vector3; shade: THREE.Vector3 }> }> = [];
  const disposers: Array<() => void> = [];
  all.forEach((v, i) => {
    const base = CENTRE.clone().addScaledVector(across, (i - (all.length - 1) / 2) * SPACING);
    const look = { ...lookFor('swatch/board'), [v.era]: v };
    const at = {} as Record<'high' | 'low', { sun: THREE.Vector3; shade: THREE.Vector3 }>;
    for (const row of ['high', 'low'] as const) {
      const t = buildTower(spec(v.id, v.era), 'high', towerMaterials(look), look);
      const lift = ROWS[row];
      t.group.position.set(base.x, lift, base.z);
      t.group.traverse((o) => {
        o.castShadow = false;
      });
      group.add(t.group);
      disposers.push(() => t.dispose());
      // Mid-height of the eight floors (the chicago root is 26 m), just proud of the wall line.
      const y = lift + 26 + 8 * 4.2 * 0.5;
      at[row] = { sun: new THREE.Vector3(base.x, y, base.z + 12.6), shade: new THREE.Vector3(base.x + 12.6, y, base.z) };
    }
    samples.push({ id: v.id, at });
  });
  const ambient = scene.getObjectByName('ambient-city');
  const wasVisible = ambient?.visible ?? true;
  if (ambient) ambient.visible = false;
  scene.add(group);
  view(eye, target);
  return {
    points(width, height) {
      camera.updateMatrixWorld();
      const px = (p: THREE.Vector3): [number, number] => {
        const q = p.clone().project(camera);
        return [((q.x + 1) / 2) * width, ((1 - q.y) / 2) * height];
      };
      return samples.map((s) => ({ id: s.id, sun: px(s.at.high.sun), shade: px(s.at.high.shade), sunLow: px(s.at.low.sun), shadeLow: px(s.at.low.shade) }));
    },
    dispose() {
      scene.remove(group);
      if (ambient) ambient.visible = wasVisible;
      for (const fn of disposers) fn();
    },
  };
}
