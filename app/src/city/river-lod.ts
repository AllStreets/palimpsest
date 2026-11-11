/**
 * How much of the river draws, chunk by chunk, from where the camera stands.
 * Pure, so it is tested in Node.
 *
 * The river is cut into chunks RIVER_CHUNK metres long so the camera's
 * frustum culls what it cannot see. Each chunk has a core (walls, copings,
 * parapets, decks, the bridges' bodies, ribs and pylon, and the lanterns'
 * glass, which is what draws the lamp lines from afar) and a detail tier
 * (the lamps' ironwork, rings, outfalls, balusters, voussoirs, hangers,
 * stays, railings and the piers' fittings), drawn only within DETAIL_NEAR.
 * Past SHADOW_NEAR a chunk casts no shadow, and past AO_NEAR it stays out of
 * the ambient occlusion pass: at that distance neither has anything to show.
 */
import { BANKS, QUAY } from '../../../shared/commute.js';

export const RIVER_CHUNK = 480;
/**
 * The seams fall at 240 m plus whole chunks, half a chunk off each bridge, so each bridge and pier sits whole
 * inside one chunk. 480 m keeps the calls down (one per material per chunk) while the frustum still culls.
 */
const REACH = 8400;
export const DETAIL_NEAR = 450;
export const SHADOW_NEAR = 400;
export const AO_NEAR = 320;

export interface Chunk {
  z0: number;
  z1: number;
}

/** Every chunk, south of the city's far edge to north of it. */
export function chunks(): Chunk[] {
  const out: Chunk[] = [];
  for (let z = -REACH; z < REACH; z += RIVER_CHUNK) out.push({ z0: z, z1: z + RIVER_CHUNK });
  return out;
}

/** The chunk a z lies in. */
export function chunkAt(z: number): number {
  return Math.floor((z + REACH) / RIVER_CHUNK);
}

/** Distance from the eye to the nearest point of a chunk's river and quays. */
export function chunkDistance(eye: { x: number; y: number; z: number }, c: Chunk): number {
  const dx = Math.max(BANKS.west - QUAY - eye.x, 0, eye.x - (BANKS.east + QUAY));
  const dz = Math.max(c.z0 - eye.z, 0, eye.z - c.z1);
  return Math.hypot(dx, Math.max(eye.y, 0), dz);
}

export function chunkLod(eye: { x: number; y: number; z: number }, c: Chunk): { detail: boolean; shadow: boolean; ao: boolean } {
  const d = chunkDistance(eye, c);
  return { detail: d < DETAIL_NEAR, shadow: d < SHADOW_NEAR, ao: d < AO_NEAR };
}

/** The water's reflection march at each quality: its steps, and the resolution of the frame it reads colour from. */
export function waterSettings(quality: 'high' | 'medium'): { steps: number; colourScale: number } {
  return quality === 'high' ? { steps: 64, colourScale: 1 } : { steps: 40, colourScale: 0.5 };
}
