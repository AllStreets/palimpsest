/**
 * What main.ts hands the screens, held for a screen main.ts does not know:
 * the command palette (Phase 5). The brief lends the city's flight to a
 * tower and the one event stream; a firm's page lends the flight to its
 * quarter. main.ts stays as it is: the palette reaches the city only
 * through the hooks the screens already receive.
 */
import type { EngineEvent } from '../api';

export interface Handoffs {
  /** Listens to the engine's one event stream while a screen is open. */
  listen?(fn: (e: EngineEvent) => void): () => void;
  /** Flies the city to a repo's tower; false when none stands yet. */
  flyToTower?(repo: string): boolean;
  /** Flies the city to a firm's quarter; false when none stands yet. */
  flyToQuarter?(firmId: string): boolean;
}

export const handoffs: Handoffs = {};
