import type { PR } from './github.js';
import type { Commit } from './mirror.js';
import type { Era, Floor, FloorSize } from '../shared/types.js';

export const MAX_FOUNDING_FLOORS = 120;
export const CLUSTER_GAP_HOURS = 6;
export const CLUSTER_MAX_LINES = 400;
export const ERA_CUTS = [0.2, 0.45, 0.7, 0.9];

const HOUR_MS = 60 * 60 * 1000;
const CLAUDE_TRAILER = /Co-Authored-By:\s*Claude/i;
/** The trailer the city writes on every commit it makes for a job. */
const JOB_TRAILER = /^Palimpsest-Job:\s*\S/im;
/** The head branch prefix of every PR the city opens. */
const CITY_BRANCH = 'palimpsest/';

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

/**
 * Builds the 'pr' floor for a PR whose mergeSha matched `mergeCommit`. Its
 * size is the merge commit's first-parent diff: for a merge or a squash,
 * everything the PR brought into the branch. (A rebase merge's other commits
 * stand on the first-parent line themselves and become their own floors.)
 */
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
    size: sizeFor(mergeCommit.lines),
    lines: mergeCommit.lines,
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

interface FloorNode {
  floor: Floor;
  /**
   * The original index (before any merging) of the leftmost floor this node
   * now represents. Relative order among surviving nodes is never disturbed
   * by merging (two adjacent nodes are replaced in place by one), so this is
   * exactly the tiebreaker a left-to-right scan would use: the smallest
   * originalPos among equally-combined pairs is the earliest pair.
   */
  originalPos: number;
  alive: boolean;
  prev: FloorNode | null;
  next: FloorNode | null;
}

interface PairEntry {
  combined: number;
  originalPos: number;
  left: FloorNode;
  right: FloorNode;
}

/** Binary min-heap over PairEntry, ordered by (combined, originalPos). */
class PairHeap {
  private items: PairEntry[] = [];

  get size(): number {
    return this.items.length;
  }

  push(entry: PairEntry): void {
    this.items.push(entry);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.isLess(this.items[i], this.items[parent])) {
        [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
        i = parent;
      } else {
        break;
      }
    }
  }

  pop(): PairEntry | undefined {
    const top = this.items[0];
    if (top === undefined) return undefined;

    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      const n = this.items.length;
      while (true) {
        const l = i * 2 + 1;
        const r = i * 2 + 2;
        let smallest = i;
        if (l < n && this.isLess(this.items[l], this.items[smallest])) smallest = l;
        if (r < n && this.isLess(this.items[r], this.items[smallest])) smallest = r;
        if (smallest === i) break;
        [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
        i = smallest;
      }
    }

    return top;
  }

  private isLess(a: PairEntry, b: PairEntry): boolean {
    if (a.combined !== b.combined) return a.combined < b.combined;
    return a.originalPos < b.originalPos;
  }
}

/**
 * Repeatedly merges the adjacent pair with the smallest combined lines until
 * at most MAX_FOUNDING_FLOORS remain. Ties keep the earliest pair.
 *
 * O(n log n): floors live in a doubly linked list so a merge touches O(1)
 * nodes, and a min-heap of adjacent-pair sums (keyed by combined lines, then
 * the left node's original position, matching the earliest-pair tiebreak)
 * finds the next merge in O(log n). Pairs invalidated by an earlier merge are
 * never removed from the heap; they are detected lazily on pop (a pair is
 * valid only while both its nodes are still alive and still each other's
 * immediate neighbour) and simply discarded, so no stale merge is ever acted
 * on and total heap traffic stays O(n).
 */
function capFloors(repo: string, floors: Floor[]): Floor[] {
  if (floors.length <= MAX_FOUNDING_FLOORS) {
    return floors;
  }

  const nodes: FloorNode[] = floors.map((floor, originalPos) => ({
    floor,
    originalPos,
    alive: true,
    prev: null,
    next: null,
  }));
  for (let i = 0; i < nodes.length; i++) {
    nodes[i].prev = i > 0 ? nodes[i - 1] : null;
    nodes[i].next = i < nodes.length - 1 ? nodes[i + 1] : null;
  }

  const heap = new PairHeap();
  const pushPair = (left: FloorNode, right: FloorNode) => {
    heap.push({
      combined: left.floor.lines + right.floor.lines,
      originalPos: left.originalPos,
      left,
      right,
    });
  };
  for (let i = 0; i < nodes.length - 1; i++) {
    pushPair(nodes[i], nodes[i + 1]);
  }

  let head = nodes[0];
  let count = nodes.length;

  while (count > MAX_FOUNDING_FLOORS) {
    let entry = heap.pop();
    while (entry && (!entry.left.alive || !entry.right.alive || entry.left.next !== entry.right)) {
      entry = heap.pop();
    }
    if (!entry) break; // unreachable while count > 1, guarded for safety only

    const { left, right } = entry;
    const merged: FloorNode = {
      floor: mergeFloors(repo, left.floor, right.floor),
      originalPos: left.originalPos,
      alive: true,
      prev: left.prev,
      next: right.next,
    };

    left.alive = false;
    right.alive = false;

    if (merged.prev) {
      merged.prev.next = merged;
    } else {
      head = merged;
    }
    if (merged.next) {
      merged.next.prev = merged;
    }

    if (merged.prev) pushPair(merged.prev, merged);
    if (merged.next) pushPair(merged, merged.next);

    count -= 1;
  }

  const result: Floor[] = [];
  for (let node: FloorNode | null = head; node; node = node.next) {
    result.push(node.floor);
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
 * - With `opts.until` set (the repo's `joinedAt`, ruling 17), only commits and
 *   PRs at or before it are used. The city's own work never becomes history:
 *   a commit carrying a `Palimpsest-Job:` trailer, a PR whose head branch
 *   starts with `palimpsest/`, and that PR's merge commit are all dropped.
 */
export function foundingFloors(
  repo: string,
  commits: Commit[],
  prs: PR[],
  opts: { until: string | null } = { until: null },
): Floor[] {
  const until = opts.until === null ? Infinity : Date.parse(opts.until);
  const inWindow = (at: string) => !(Date.parse(at) > until);
  const cityPrs = prs.filter((pr) => pr.headRefName.startsWith(CITY_BRANCH));
  const cityMergeShas = new Set(cityPrs.map((pr) => pr.mergeSha).filter((sha): sha is string => sha !== null));
  const keptCommits = commits.filter(
    (c) => inWindow(c.at) && !JOB_TRAILER.test(c.body) && !cityMergeShas.has(c.sha),
  );
  const keptPrs = prs.filter((pr) => inWindow(pr.mergedAt) && !pr.headRefName.startsWith(CITY_BRANCH));
  const floors = buildFloors(repo, keptCommits, keptPrs);
  const capped = capFloors(repo, floors);
  return withEras(capped);
}
