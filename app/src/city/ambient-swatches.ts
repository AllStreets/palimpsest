import * as THREE from 'three';

import { ARCHETYPES, SECTIONS, sectionHeight, TONES, type Lot } from './lots';

/**
 * A measuring board for the ambient city's tones, beside the towers' own
 * (tower/swatches.ts): one plain building per tone, of its type and in its
 * colours, floated clear of the city at the overview's distance and bearing
 * so its faces take the real dusk light, sky, haze, tone mapping and post.
 * tools/capture.ts (the `ambient` shot) reads each building's sunlit and
 * shaded face and writes their Lab colours to ambient-rendered.ts, which
 * the tests hold the palette's spread to and lots.ts keeps plaza edges by.
 */

/** The overview's eye relative to what it looks at (as tower/swatches.ts). */
const OVERVIEW_OFFSET = new THREE.Vector3(580, 310, 960);
const CENTRE = new THREE.Vector3(-900, 0, -700);
const SPACING = 46;
const PER_ROW = 14;
const ROW_LIFT = 72;
const SIZE = 30;

export interface AmbientSwatchPoint {
  id: string;
  sun: [number, number];
  shade: [number, number];
}

export function ambientBoard(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  draw: (lots: Lot[]) => { group: THREE.Group; dispose(): void },
  view: (eye: THREE.Vector3, target: THREE.Vector3) => void,
): { points(width: number, height: number): AmbientSwatchPoint[]; dispose(): void } {
  const all = ARCHETYPES.flatMap((a) => TONES[a].map((t) => ({ a, t })));
  const rows = Math.ceil(all.length / PER_ROW);
  const mid = new THREE.Vector3(0, (rows - 1) * ROW_LIFT * 0.5 + 20, 0);
  const eye = CENTRE.clone().add(mid).add(OVERVIEW_OFFSET);
  const target = CENTRE.clone().add(mid);
  const d = new THREE.Vector3(target.x - eye.x, 0, target.z - eye.z).normalize();
  const across = new THREE.Vector3(-d.z, 0, d.x);
  const lots: Lot[] = [];
  const samples: Array<{ id: string; sun: THREE.Vector3; shade: THREE.Vector3 }> = [];
  all.forEach(({ a, t }, i) => {
    const row = Math.floor(i / PER_ROW);
    const col = i % PER_ROW;
    const base = CENTRE.clone().addScaledVector(across, (col - (PER_ROW - 1) / 2) * SPACING);
    const s = SECTIONS[a];
    // About 40 m of building, as its type builds it (a walk-up tops out lower).
    const n = Math.min(s.tall?.[1] ?? s.storeys[1], Math.max(2, Math.round((40 - s.ground) / s.floor)));
    const h = sectionHeight(a, n);
    const lift = row * ROW_LIFT;
    const colour = new THREE.Color(t.wall);
    lots.push({
      x: base.x,
      z: base.z,
      w: SIZE,
      d: SIZE,
      h,
      archetype: a,
      hood: 'midtown',
      tone: t.id,
      colour,
      accent: new THREE.Color(t.accent),
      style: [t.reflect ?? t.paint, 0.5, 0.36, (t.siding ? 2 : 0) + 0.2],
      roof: 'flat',
      front: ['px', 'nx', 'pz', 'nz'],
      stack: 0,
      index: i,
    });
    // Upper floors, clear of the shopfronts and the parapet, just proud of the wall.
    const y = lift + Math.max(s.ground + 2, h * 0.6);
    samples.push({ id: t.id, sun: new THREE.Vector3(base.x, y, base.z + SIZE / 2 + 0.05), shade: new THREE.Vector3(base.x + SIZE / 2 + 0.05, y, base.z) });
  });
  // One board per row, each lifted clear of the row below.
  const group = new THREE.Group();
  group.name = 'ambient-board';
  const boards: Array<{ group: THREE.Group; dispose(): void }> = [];
  for (let row = 0; row < rows; row++) {
    const b = draw(lots.slice(row * PER_ROW, (row + 1) * PER_ROW));
    b.group.position.y = row * ROW_LIFT;
    group.add(b.group);
    boards.push(b);
  }
  const board = { group, dispose: () => boards.forEach((b) => b.dispose()) };
  const ambient = scene.getObjectByName('ambient-city');
  const wasVisible = ambient?.visible ?? true;
  if (ambient) ambient.visible = false;
  scene.add(board.group);
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
      scene.remove(board.group);
      if (ambient) ambient.visible = wasVisible;
      board.dispose();
    },
  };
}
