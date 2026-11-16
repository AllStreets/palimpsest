import * as THREE from 'three';

import { type Plaza } from './grid.js';
import { BANKS } from '../../../shared/commute.js';
import { materials, texture, worldBox } from './materials.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COPING } from './river.js';
import { streetSurface, type RankSpot, type StreetSurface } from './street.js';

export { MAX_PLAZAS } from './street.js';
const GROUND_SIZE = 16000;
/** Metres per paving texture tile. */
const PAVE_TILE = 4;
/** The plinth's base course, in metres (its steps add 4 m each side). */
const PLINTH_FOOT = 34;

export interface Ground {
  /** The ground plane and the kerb tiles standing on it. */
  group: THREE.Group;
  /** The ground plane alone. */
  mesh: THREE.Mesh;
  /** The street surface drawn on it (street.ts). */
  street: StreetSurface;
  setPlazas(plazas: Plaza[]): void;
  /** Plazas the ground paves now, the civic plaza included (tests and debugging). */
  plazas(): number;
  /** The cab ranks the asphalt darkens under. */
  setRanks(ranks: RankSpot[]): void;
  /** Follows the eye: the kerb tiles refill round it. */
  update(eye: THREE.Vector3): void;
  dispose(): void;
}

/**
 * The ground: precast stone paving everywhere, asphalt lanes down every
 * street with kerbs, gutters and the wear of traffic (street.ts), open paved
 * plazas where districts and the civic plaza sit, and the light pools of the
 * sodium lamps (the lamps in grid.ts sit on the same lattice the shader
 * computes, so every pool has its lamp). Pools are albedo-weighted
 * irradiance, not paint, so asphalt takes less light than stone.
 */
export function createGround(quality: 'high' | 'medium' = 'high'): Ground {
  // Two halves either side of the river's channel (and its granite copings): the water lies below in the gap.
  const holeW = BANKS.west - COPING;
  const holeE = BANKS.east + COPING;
  const half = GROUND_SIZE / 2;
  const westG = new THREE.PlaneGeometry(holeW + half, GROUND_SIZE, 1, 1).translate((holeW - half) / 2, 0, 0);
  const eastG = new THREE.PlaneGeometry(half - holeE, GROUND_SIZE, 1, 1).translate((holeE + half) / 2, 0, 0);
  const geo = mergeGeometries([westG, eastG])!;
  westG.dispose();
  eastG.dispose();
  // UVs from position, centred on zero, so precision is best where the city is.
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / PAVE_TILE, pos.getY(i) / PAVE_TILE);

  const paveArm = texture('pave_arm.jpg');
  const street = streetSurface(quality, { pave: texture('pave_diff.jpg', true), paveNormal: texture('pave_nor.jpg'), paveArm, granite: texture('granite_diff.jpg', true) });
  const mesh = new THREE.Mesh(geo, street.asphalt);
  mesh.rotation.x = -Math.PI / 2;
  mesh.receiveShadow = true;
  mesh.name = 'ground';
  const group = new THREE.Group();
  group.name = 'ground';
  group.add(mesh);
  group.add(street.kerbs);

  return {
    group,
    mesh,
    street,
    setPlazas: (plazas) => street.setPlazas(plazas),
    plazas: () => street.plazas(),
    setRanks: (ranks) => street.setRanks(ranks),
    update: (eye) => void street.update(eye),
    dispose() {
      geo.dispose();
      street.dispose();
    },
  };
}

/**
 * A plain dressed-stone plinth reserving a district's place: three steps, a
 * base and a cornice, washed with warm floodlight from the ground (the
 * plaza's floor shows the matching spill). Towers stand on this footprint
 * from Task 8.
 */
export function makePlinth(): THREE.Group {
  const mat = floodlitStone();
  const g = new THREE.Group();
  const FOOT = PLINTH_FOOT;
  for (let s = 0; s < 3; s++) {
    const step = worldBox(FOOT + 8 - s * 2, 0.45, FOOT + 8 - s * 2, mat, 2.5);
    step.position.y = 0.225 + s * 0.45;
    g.add(step);
  }
  const base = worldBox(FOOT, 2.6, FOOT, mat, 2.2);
  base.position.y = 1.35 + 1.3;
  g.add(base);
  const cornice = worldBox(FOOT + 1.4, 0.7, FOOT + 1.4, mat, 2.2);
  cornice.position.y = 1.35 + 2.6 + 0.35;
  g.add(cornice);
  return g;
}

let floodlit: THREE.MeshStandardMaterial | null = null;

/**
 * The sandstone scan lit as if by floodlights at the plinth's foot: warm
 * light on the sides falling off with height, a little on the top. Light
 * here is albedo-weighted, so the stone's own texture carries it.
 */
function floodlitStone(): THREE.MeshStandardMaterial {
  if (floodlit) return floodlit;
  const sand = materials().sand;
  const m = new THREE.MeshStandardMaterial({
    map: sand.map,
    normalMap: sand.normalMap,
    aoMap: sand.aoMap,
    roughnessMap: sand.roughnessMap,
    color: 0xf3e9da,
    roughness: 1,
  });
  m.customProgramCacheKey = () => 'palimpsest-floodlit-stone';
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFlP; varying vec3 vFlN;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvFlP = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvFlN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFlP; varying vec3 vFlN;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float side = 1.0 - abs(vFlN.y);
        float wash = side * (0.35 + 0.9 * exp(-vFlP.y / 2.2)) + (1.0 - side) * 0.25;
        totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.7, 0.42) * wash * 1.1;`,
      );
  };
  floodlit = m;
  return m;
}
