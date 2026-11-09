/**
 * Which plots in the city are taken. Pure, so it is tested in Node.
 *
 * One rule, used by everything that draws a plot (the towers and scaffolds,
 * the ground's paved plazas, the ambient blocks cut away round them, the
 * collar that keeps those blocks under a root, and the name plates): a plot is
 * occupied by a connected repo that is analyzing or has a tower. Anything
 * else (disconnected, toggled off, a connect stopped before any tower stood,
 * a first analysis that failed) leaves its plot to the ambient city. The slot
 * itself stays the repo's in the engine, so reconnecting returns it there.
 */
import { districtOrigin } from '../../../shared/district-layout.js';
import { ROOT_HEIGHT } from '../../../shared/tower-layout.js';
import type { District, Repo } from '../../../shared/types.js';
import type { CollarPlaza } from './collar.js';

/** What the page knows of a repo: enough to place it. */
export type RepoState = Pick<Repo, 'fullName' | 'slot' | 'connected' | 'status'>;

/** A connected repo's first analysis, still running: its plot carries a scaffold. */
export interface SiteSpot {
  repo: string;
  origin: { x: number; z: number };
}

export interface Occupancy {
  /** Towers that stand: connected repos with a tower, in the city's order. */
  districts: District[];
  /** Scaffolds: connected repos analyzing with no tower yet. */
  sites: SiteSpot[];
}

export function occupancy(repos: Iterable<RepoState>, districts: District[]): Occupancy {
  const known = new Map<string, RepoState>();
  for (const r of repos) known.set(r.fullName, r);
  // The engine serves only connected repos' towers; one the page has not read yet is taken at its word.
  const standing = districts.filter((d) => known.get(d.repo)?.connected !== false);
  const towered = new Set(standing.map((d) => d.repo));
  const sites: SiteSpot[] = [];
  for (const r of known.values()) {
    if (r.connected && r.status === 'analyzing' && !towered.has(r.fullName)) sites.push({ repo: r.fullName, origin: districtOrigin(r.slot) });
  }
  return { districts: standing, sites };
}

/** The occupied plots as plazas: a district carries its root's height for the collar, a site none. */
export function plazasOf(occ: Occupancy): CollarPlaza[] {
  return [
    ...occ.districts.map((d) => ({ x: d.origin.x, z: d.origin.z, rootHeight: ROOT_HEIGHT[d.tower.root] })),
    ...occ.sites.map((s) => ({ ...s.origin })),
  ];
}
