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
 *
 * A firm's quarter is occupied by the same rule: while its firm has any
 * tower standing, dark or not. Firms and repos share one slot numbering in
 * the engine, so a quarter never takes a district's plot; should a stale
 * answer ever put one on a plot a district or a site holds, the district
 * keeps it. A quarter whose last tower has gone leaves its court to the
 * ambient city exactly as a freed district plot does.
 */
import { districtOrigin, QUARTER_COURT } from '../../../shared/district-layout.js';
import { agentRootHeight, ROOT_HEIGHT } from '../../../shared/tower-layout.js';
import type { District, Quarter, Repo } from '../../../shared/types.js';
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
  /** Firms' quarters with any tower standing, dark or not, in slot order. */
  quarters: Quarter[];
}

export function occupancy(repos: Iterable<RepoState>, districts: District[], quarters: Quarter[] = []): Occupancy {
  const known = new Map<string, RepoState>();
  for (const r of repos) known.set(r.fullName, r);
  // The engine serves only connected repos' towers; one the page has not read yet is taken at its word.
  const standing = districts.filter((d) => known.get(d.repo)?.connected !== false);
  const towered = new Set(standing.map((d) => d.repo));
  const sites: SiteSpot[] = [];
  for (const r of known.values()) {
    if (r.connected && r.status === 'analyzing' && !towered.has(r.fullName)) sites.push({ repo: r.fullName, origin: districtOrigin(r.slot) });
  }
  const taken = new Set([...standing.map((d) => `${d.origin.x},${d.origin.z}`), ...sites.map((s) => `${s.origin.x},${s.origin.z}`)]);
  const courts = quarters.filter((q) => q.towers.length > 0 && !taken.has(`${q.origin.x},${q.origin.z}`)).sort((a, b) => a.slot - b.slot);
  return { districts: standing, sites, quarters: courts };
}

/** A quarter's standing plots, one bit per tower index. */
export function plotsOf(q: Quarter): number {
  return q.towers.reduce((bits, t, i) => bits | (1 << (t.towerIndex ?? i)), 0);
}

/**
 * The occupied plots as plazas: a district carries its root's height for the
 * collar, and its tower's rendered colours when `tones` gives them (so the
 * blocks at its edge keep clear of them); a site carries neither; a quarter
 * carries its court, its standing plots and its agents' lowest root.
 */
export function plazasOf(occ: Occupancy, tones?: (d: District) => { tones: Array<[number, number, number]>; value?: number }): CollarPlaza[] {
  return [
    ...occ.districts.map((d) => ({ x: d.origin.x, z: d.origin.z, rootHeight: ROOT_HEIGHT[d.tower.root], ...(tones ? tones(d) : {}) })),
    ...occ.sites.map((s) => ({ ...s.origin })),
    ...occ.quarters.map((q) => ({
      x: q.origin.x,
      z: q.origin.z,
      rootHeight: Math.min(...q.towers.map((t) => agentRootHeight(t.root))),
      court: QUARTER_COURT,
      towers: plotsOf(q),
      ...(q.dark ? { dark: true } : {}),
    })),
  ];
}
