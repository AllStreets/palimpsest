import * as THREE from 'three';

import { parseGlb } from './kits.js';

/**
 * The city's people as modelled in Blender by tools/kits/figures.py and
 * written to app/public/kits/figures.glb: one clothed, sculpted figure (a
 * head with its features, hands, a coat with seams and folds, trousers,
 * shoes) with the variants a crowd wears (four heads of hair, a felt hat, a
 * flat cap, a scarf), at two levels: `hi` for the close level and `lo` for
 * the near. Per vertex: aSkin (bone a, bone b, the weight of b out of 255,
 * a blush out of 255) and aSurf (surface code, variant part, the coat tail
 * out of 255, baked occlusion out of 255). The crowd (ambient.ts) and the
 * personas (people.ts) draw the same meshes, posed by the same skinning.
 */

export type FigureLevel = 'hi' | 'lo';

/**
 * What figures.glb may weigh: the hi level at about 17.5k triangles across
 * every variant (about 11.7k worn at once), the lo level at about 3k, in
 * the compact layout (24 bytes a point, 2 an index): about 390 KB, held
 * under 420 KB by test/figures.test.ts.
 */
export const FIGURES_BUDGET = 420_000;

/**
 * The skin atlas, app/public/kits/figures-skin.webp (figures.py): 1024 by
 * 1024, four skin tones in its quadrants (pale at the top left, then
 * olive, brown and deep, row by row), each the tone's colour with its
 * breakup (mottling, freckles on the paler two) and its pores as pits in
 * the colour, which the shader reads as height. The close level's face and hands map onto one quadrant
 * (the figure's own tone picks it); the near and far levels never read it,
 * so it is fetched only when a close figure is first drawn (loadSkin).
 */
export const FIGURES_SKIN_BUDGET = 262_144;

const levels = new Map<FigureLevel, THREE.BufferGeometry>();

/** Registers the figure levels of a figures GLB (node tests read app/public/kits/figures.glb from disk). */
export function registerFigures(buf: ArrayBuffer): void {
  for (const [name, geo] of parseGlb(buf)) {
    if (name === 'figure.hi' || name === 'figure.lo') {
      // Only the close level maps onto the skin atlas; the near level carries no uvs.
      if (name === 'figure.lo') geo.deleteAttribute('uv');
      levels.set(name.slice('figure.'.length) as FigureLevel, geo);
    }
  }
}

/** The skin atlas's uniforms, shared by every close-level figure material: the texture and whether it has landed. */
export const SKIN_UNIFORMS = { uSkin: { value: null as THREE.Texture | null }, uSkinOn: { value: 0 } };

let skinLoading: Promise<void> | null = null;
/**
 * Fetches the skin atlas once, the first time a close figure is drawn
 * (people.ts and ambient.ts call this as they write a close instance); until
 * it lands, or if it never does, the skin is its flat tone.
 */
export function loadSkin(): Promise<void> {
  if (skinLoading) return skinLoading;
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  skinLoading = (async () => {
    const r = await fetch(`${base}kits/figures-skin.webp`);
    if (!r.ok) throw new Error(`figures-skin: ${r.status}`);
    const blob = await r.blob();
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const tex = new THREE.Texture(bitmap);
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.anisotropy = 4;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    SKIN_UNIFORMS.uSkin.value = tex;
    SKIN_UNIFORMS.uSkinOn.value = 1;
  })().catch((err: unknown) => {
    // Node tests and a missing file: the figures keep their flat skin tone.
    if (typeof createImageBitmap === 'function') console.warn('the skin atlas did not load; the faces keep their flat tone', err);
  });
  return skinLoading;
}

/** Whether the skin atlas has been asked for (tests of the deferred load). */
export function skinRequested(): boolean {
  return skinLoading !== null;
}

/** Forgets the skin atlas (tests). */
export function clearSkin(): void {
  skinLoading = null;
  SKIN_UNIFORMS.uSkin.value?.dispose();
  SKIN_UNIFORMS.uSkin.value = null;
  SKIN_UNIFORMS.uSkinOn.value = 0;
}

let loading: Promise<void> | null = null;
/** Fetches and registers the figures once; without them the people stand as plain figures (figureLevel is null). */
export function loadFigures(): Promise<void> {
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  loading ??= fetch(`${base}kits/figures.glb`)
    .then((r) => {
      if (!r.ok) throw new Error(`figures: ${r.status}`);
      return r.arrayBuffer();
    })
    .then(registerFigures);
  return loading;
}

export function hasFigures(): boolean {
  return levels.has('hi') && levels.has('lo');
}

/** A fresh copy of a level (its owner sets instanced attributes on it and disposes it), or null when the figures did not load. */
export function figureLevel(level: FigureLevel): THREE.BufferGeometry | null {
  const g = levels.get(level);
  return g ? g.clone() : null;
}

/** Forgets the registered figures (tests of the plain fallback). */
export function clearFigures(): void {
  levels.clear();
}
