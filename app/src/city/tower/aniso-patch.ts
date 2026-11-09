import * as THREE from 'three';

/**
 * The brushed-metal shader patch. three's anisotropic path divides by zero
 * where a face's UVs give no tangent, or where the bitangent lines up with the
 * view; one NaN pixel then spreads through the bloom chain to the whole frame.
 * The patch falls back to a tangent from the normal and keeps the bent normal
 * finite. It works by replacing exact lines of three's shader text, so each
 * line it needs is listed here and checked when the module loads: a three
 * whose text has moved on is caught, never silently left unpatched.
 */
export const ANISO_PATCHES = [
  {
    chunk: 'lights_physical_fragment',
    target: 'material.anisotropyB = tbn[ 1 ] * anisotropyV.x - tbn[ 0 ] * anisotropyV.y;',
    replacement: `material.anisotropyB = tbn[ 1 ] * anisotropyV.x - tbn[ 0 ] * anisotropyV.y;
      if ( dot( material.anisotropyT, material.anisotropyT ) < 1e-8 || dot( material.anisotropyB, material.anisotropyB ) < 1e-8 ) {
        vec3 upRef = abs( normal.y ) < 0.99 ? vec3( 0.0, 1.0, 0.0 ) : vec3( 1.0, 0.0, 0.0 );
        material.anisotropyB = normalize( cross( normal, upRef ) );
        material.anisotropyT = cross( material.anisotropyB, normal );
      }`,
  },
  {
    chunk: 'envmap_physical_pars_fragment',
    target: 'bentNormal = normalize( cross( bentNormal, bitangent ) );',
    replacement: 'bentNormal = normalize( cross( bentNormal, bitangent ) + normal * 1e-4 );',
  },
] as const;

type Chunks = Record<string, string>;

/** What the patch needs but cannot find: a replaced line missing from its chunk, or a chunk the physical shader no longer includes. */
export function missingAnisoTargets(
  chunks: Chunks = THREE.ShaderChunk as unknown as Chunks,
  physicalFragment: string = THREE.ShaderLib.physical.fragmentShader,
): string[] {
  const missing: string[] = [];
  for (const p of ANISO_PATCHES) {
    if (!(chunks[p.chunk] ?? '').includes(p.target)) missing.push(`${p.chunk}: ${p.target}`);
    if (!physicalFragment.includes(`#include <${p.chunk}>`)) missing.push(`physical fragment shader: #include <${p.chunk}>`);
  }
  return missing;
}

/** True when every line the patch replaces is where it expects. Checked once, at load. */
export const ANISO_PATCH_OK = (() => {
  const missing = missingAnisoTargets();
  if (missing.length === 0) return true;
  console.error(
    `Palimpsest: three's shader text has changed, so brushed metal is drawn without anisotropy rather than risk NaN pixels. Missing:\n  ${missing.join('\n  ')}`,
  );
  return false;
})();

/** Swaps the patched chunks into a MeshPhysicalMaterial's fragment shader. Only call when ANISO_PATCH_OK. */
export function patchAnisotropy(fragmentShader: string): string {
  let out = fragmentShader;
  for (const p of ANISO_PATCHES) {
    const chunk = (THREE.ShaderChunk as unknown as Chunks)[p.chunk].replaceAll(p.target, p.replacement);
    out = out.replace(`#include <${p.chunk}>`, chunk);
  }
  return out;
}
