import { districtOrigin } from '../shared/district-layout.js';

// The district grid is shared with the app, which places analyzing sites before their towers exist.
export { DISTRICT_PITCH, districtOrigin } from '../shared/district-layout.js';

/** An agent tower's floor width in metres (ruling 15); district towers use 26 m. */
export const AGENT_TOWER_WIDTH = 16;

/**
 * Where a firm's quarter stands. Firms and repos share one slot numbering
 * (`nextSlot`), so a quarter takes the plot on the district spiral its slot
 * names, the same way a repo's district does.
 */
export function quarterOrigin(slot: number): { x: number; z: number } {
  return districtOrigin(slot);
}
