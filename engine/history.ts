import type { PR } from './github.js';
import type { Commit } from './mirror.js';
import type { Era, Floor, FloorSize } from '../shared/types.js';

export const MAX_FOUNDING_FLOORS = 120;
export const CLUSTER_GAP_HOURS = 6;
export const CLUSTER_MAX_LINES = 400;
export const ERA_CUTS = [0.2, 0.45, 0.7, 0.9];

const HOUR_MS = 60 * 60 * 1000;
const CLAUDE_TRAILER = /Co-Authored-By:\s*Claude/i;

function sizeFor(lines: number): FloorSize {
  if (lines < 50) return 'small';
  if (lines < 400) return 'medium';
  return 'large';
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** Builds the 'commits' floor for a closed cluster of one or more commits. */
function clusterFloor(repo: string, cluster: Commit[]): Floor {
  const first = cluster[0];
  const last = cluster[cluster.length - 1];
  const refs =
    cluster.length === 1 ? [shortSha(first.sha)] : [`${shortSha(first.sha)}..${shortSha(last.sha)}`];
  const lines = cluster.reduce((sum, c) => sum + c.lines, 0);
  const claude = cluster.some((c) => CLAUDE_TRAILER.test(c.body));

  return {
    id: `${repo}#${refs[0]}`,
    repo,
    kind: 'commits',
    refs,
    title: first.subject,
    at: last.at,
    era: 'stone',
    size: sizeFor(lines),
    lines,
    claude,
    founding: true,
    url: null,
  };
}

/** Builds the 'pr' floor for a PR whose mergeSha matched `mergeCommit`. */
function prFloor(repo: string, pr: PR, mergeCommit: Commit): Floor {
  const refs = [`#${pr.number}`];

  return {
    id: `${repo}#${refs[0]}`,
    repo,
    kind: 'pr',
    refs,
    title: pr.title,
    at: pr.mergedAt,
    era: 'stone',
    size: sizeFor(pr.lines),
    lines: pr.lines,
    claude: CLAUDE_TRAILER.test(mergeCommit.body),
    founding: true,
    url: pr.url,
  };
}

/** Walks commits in chronological order, emitting a floor per PR merge commit or closed cluster. */
function buildFloors(repo: string, commits: Commit[], prs: PR[]): Floor[] {
  const commitShas = new Set(commits.map((c) => c.sha));
  const prByMergeSha = new Map<string, PR>();
  for (const pr of prs) {
    if (pr.mergeSha !== null && commitShas.has(pr.mergeSha)) {
      prByMergeSha.set(pr.mergeSha, pr);
    }
  }

  const floors: Floor[] = [];
  let cluster: Commit[] = [];

  const closeCluster = () => {
    if (cluster.length > 0) {
      floors.push(clusterFloor(repo, cluster));
      cluster = [];
    }
  };

  commits.forEach((commit, i) => {
    const pr = prByMergeSha.get(commit.sha);
    if (pr) {
      closeCluster();
      floors.push(prFloor(repo, pr, commit));
      return;
    }

    if (cluster.length > 0) {
      const prev = commits[i - 1];
      const gapHours = (Date.parse(commit.at) - Date.parse(prev.at)) / HOUR_MS;
      const clusterLines = cluster.reduce((sum, c) => sum + c.lines, 0);
      const fits =
        commit.author === cluster[0].author &&
        gapHours <= CLUSTER_GAP_HOURS &&
        clusterLines + commit.lines <= CLUSTER_MAX_LINES;

      if (fits) {
        cluster.push(commit);
        return;
      }

      closeCluster();
    }

    cluster = [commit];
  });

  closeCluster();
  return floors;
}

/** Merges two chronologically adjacent floors into one, per the cap rule. */
function mergeFloors(repo: string, earlier: Floor, later: Floor): Floor {
  const refs = [...earlier.refs, ...later.refs];
  const lines = earlier.lines + later.lines;

  return {
    id: `${repo}#${refs[0]}`,
    repo,
    kind: earlier.kind === 'pr' || later.kind === 'pr' ? 'pr' : 'commits',
    refs,
    title: earlier.title,
    at: later.at,
    era: 'stone',
    size: sizeFor(lines),
    lines,
    claude: earlier.claude || later.claude,
    founding: true,
    url: earlier.url ?? later.url,
  };
}

/**
 * Repeatedly merges the adjacent pair with the smallest combined lines until
 * at most MAX_FOUNDING_FLOORS remain. Ties keep the earliest pair, matched by
 * a strict less-than comparison that never displaces an earlier best.
 */
function capFloors(repo: string, floors: Floor[]): Floor[] {
  let result = floors;

  while (result.length > MAX_FOUNDING_FLOORS) {
    let bestIndex = 0;
    let bestCombined = Infinity;

    for (let i = 0; i < result.length - 1; i++) {
      const combined = result[i].lines + result[i + 1].lines;
      if (combined < bestCombined) {
        bestCombined = combined;
        bestIndex = i;
      }
    }

    const merged = mergeFloors(repo, result[bestIndex], result[bestIndex + 1]);
    result = [...result.slice(0, bestIndex), merged, ...result.slice(bestIndex + 2)];
  }

  return result;
}

function eraFor(t: number): Era {
  if (t < ERA_CUTS[0]) return 'stone';
  if (t < ERA_CUTS[1]) return 'brick';
  if (t < ERA_CUTS[2]) return 'glass';
  if (t < ERA_CUTS[3]) return 'titanium';
  return 'scifi';
}

/** Assigns eras from the final floors' `at` values, oldest to newest. */
function withEras(floors: Floor[]): Floor[] {
  if (floors.length === 0) return floors;

  const firstAt = Date.parse(floors[0].at);
  const lastAt = Date.parse(floors[floors.length - 1].at);
  const span = lastAt - firstAt;

  return floors.map((floor) => {
    const t = span === 0 ? 1 : (Date.parse(floor.at) - firstAt) / span;
    return { ...floor, era: eraFor(t) };
  });
}

/**
 * Turns a repo's first-parent commit history and merged PRs into founding
 * floors, oldest first. Pure: no I/O, no filesystem or process access.
 *
 * - A commit whose sha matches a PR's mergeSha becomes that PR's floor; a PR
 *   whose mergeSha matches no commit in `commits` is ignored (merged
 *   elsewhere).
 * - Other commits cluster while same author, gap to the previous commit at
 *   most CLUSTER_GAP_HOURS, and cluster lines (including the new commit) at
 *   most CLUSTER_MAX_LINES.
 * - While floors exceed MAX_FOUNDING_FLOORS, the adjacent pair with the
 *   smallest combined lines is merged (earliest pair on a tie).
 * - Eras are assigned after capping, from the final floors' `at` values.
 */
export function foundingFloors(repo: string, commits: Commit[], prs: PR[]): Floor[] {
  const floors = buildFloors(repo, commits, prs);
  const capped = capFloors(repo, floors);
  return withEras(capped);
}
