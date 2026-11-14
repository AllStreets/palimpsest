/**
 * The campus's one opaque material (site.ts explains the kinds): a
 * MeshStandardMaterial whose fragment picks a scan by `vKind`. The brick
 * scan is its own map; the limestone, ashlar and gravel scans come in as
 * uniforms (gravel is the sand scan at a fine tile); slate is coursed in the
 * shader, turf is mottled and striped, the lamp kind emits its tone, and the
 * dial kind is the exchange's painted clock dial, lit from behind after
 * sunset (the `uDialLit` uniform, which the material's userData exposes to
 * the clock tower). The observatory's kinds (Task 36): copper whose patina
 * is painted here from its own UVs (metres across and along the dome, so
 * the standing seams and the streaks keep their size), a smooth paint, a
 * brass lit by `uPlateLit` while the master is trusted, and the warm lining
 * inside the dome lit by `uSlitLit` while the shutters are open. The line
 * kind (Task 38) is a bare emitter for the school towers' lit lines and
 * lamps, which draw in this masonry too. App only: it loads textures.
 */
import * as THREE from 'three';

import { clockDial } from '../exchange.js';
import { lightsOutLit } from '../lightsout.js';
import { texture } from '../materials.js';
import { patchMasonryShader } from './masonry-shader.js';

export function masonryMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: texture('brick_diff.jpg', true),
    normalMap: texture('brick_nor.jpg'),
    roughnessMap: texture('brick_arm.jpg'),
    vertexColors: true,
    roughness: 1,
    metalness: 0,
    normalScale: new THREE.Vector2(0.9, 0.9),
    envMapIntensity: 0.6,
  });
  const u = {
    uSandMap: { value: texture('sand_diff.jpg', true) },
    uSandNor: { value: texture('sand_nor.jpg') },
    uSandArm: { value: texture('sand_arm.jpg') },
    uAshMap: { value: texture('ashlar_diff.jpg', true) },
    uAshNor: { value: texture('ashlar_nor.jpg') },
    uAshArm: { value: texture('ashlar_arm.jpg') },
    uDial: { value: clockDial() ?? texture('sand_diff.jpg', true) },
    uDialLit: { value: 0 },
    uSlitLit: { value: 0 },
    uPlateLit: { value: 0 },
  };
  m.userData.dialLit = u.uDialLit;
  m.userData.slitLit = u.uSlitLit;
  m.userData.plateLit = u.uPlateLit;
  m.customProgramCacheKey = () => 'palimpsest-campus-masonry';
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    patchMasonryShader(sh);
  };
  // A school tower's masonry goes dark with its firm (scene.ts lights the school root's tree too); the patch declares the
  // lights-out term the bare emitter kind reads. The zones are positional, so the campus is never in one.
  lightsOutLit(m);
  return m;
}
