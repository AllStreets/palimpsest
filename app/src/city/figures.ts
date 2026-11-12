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

const levels = new Map<FigureLevel, THREE.BufferGeometry>();

/** Registers the figure levels of a figures GLB (node tests read app/public/kits/figures.glb from disk). */
export function registerFigures(buf: ArrayBuffer): void {
  for (const [name, geo] of parseGlb(buf)) {
    if (name === 'figure.hi' || name === 'figure.lo') {
      geo.deleteAttribute('uv');
      levels.set(name.slice('figure.'.length) as FigureLevel, geo);
    }
  }
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
