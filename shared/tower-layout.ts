import type { Floor, FloorSize, RootStyle, TowerSpec } from './types.js';

export const ROOT_HEIGHT: Record<RootStyle, number> = {
  beauxarts: 30,
  roman: 24,
  gothic: 34,
  pagoda: 28,
  chicago: 26,
};

export const FLOOR_HEIGHT: Record<FloorSize, number> = {
  small: 3.6,
  medium: 4.2,
  large: 5.2,
};

/**
 * An agent's tower stands on its firm's root at the agent's scale (16 m
 * floors over a district's 26, ruling 15): the same vernacular, smaller in
 * every dimension, so four of them stand round one court as a quarter.
 */
export const AGENT_ROOT_SCALE = 16 / 26;

/** The height of an agent tower's root in `root`'s vernacular. */
export function agentRootHeight(root: RootStyle): number {
  return ROOT_HEIGHT[root] * AGENT_ROOT_SCALE;
}

export interface LaidFloor {
  floor: Floor;
  y0: number;
  h: number;
}

export interface TowerLayout {
  rootHeight: number;
  floors: LaidFloor[];
  datumY: number;
  top: number;
}

/**
 * Stacks a tower's floors from the top of its root (an agent's at the agent
 * scale) upward, in the order they appear in `spec.floors` (oldest first). `datumY` sits at the top of the
 * floors below `spec.datumIndex` (the founding floors); `top` sits at the top
 * of every floor, founding or not.
 */
export function layoutTower(spec: TowerSpec): TowerLayout {
  const rootHeight = spec.kind === 'agent' ? agentRootHeight(spec.root) : ROOT_HEIGHT[spec.root];

  const floors: LaidFloor[] = [];
  let y = rootHeight;
  let datumY = rootHeight;

  spec.floors.forEach((floor, i) => {
    const h = FLOOR_HEIGHT[floor.size];
    floors.push({ floor, y0: y, h });
    y += h;
    if (i < spec.datumIndex) {
      datumY = y;
    }
  });

  return { rootHeight, floors, datumY, top: y };
}
