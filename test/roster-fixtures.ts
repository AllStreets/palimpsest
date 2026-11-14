/**
 * Fakes for the school roster and commissions (Phase 4 Task 23): ready
 * arenas, finished voyages with a champion, firms with a balance on record
 * and floors on a repo. Every row is written straight to the temp home's
 * tables, with the ledger entry replay reads beside it. No Beagle, no model.
 */
import { openDb } from '../engine/db.js';
import { record } from '../engine/ledger.js';
import { agentTowerId } from '../engine/market/firms.js';
import { layEarnedFloor } from '../engine/repos.js';
import { NOT_COMPARED } from '../engine/school/voyages.js';
import { VOYAGE } from '../shared/school-rules.js';
import type { ArenaInfo, Firm, Genome, Graduate, ModelRef, VoyageView } from '../shared/types.js';

export const LOCAL: ModelRef = 'ollama:qwen2.5-coder:7b';

/** A ready arena on `repo`, in the arenas table and the ledger. */
export function readyArena(id: string, repo: string, over: Partial<ArenaInfo> = {}): ArenaInfo {
  const info: ArenaInfo = {
    id,
    repo,
    kind: 'planted',
    sha: 'a'.repeat(40),
    tasks: { breeding: 4, race: 3, sealed: 3 },
    candidates: 10,
    kept: 10,
    sealedUses: 0,
    sealedHash: 'h'.repeat(64),
    builtAt: '2026-11-01T00:00:00.000Z',
    status: 'ready',
    reason: null,
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO arenas (id, repo, json) VALUES (?, ?, ?)').run(info.id, info.repo, JSON.stringify(info));
  record('arena.built', { arena: info });
  return info;
}

/** Writes a firm's books as seeding does: the stored firm and its `firm.seeded` entry, whose balance the treasury opens with. */
export function firmWith(id: string, balance: number, over: Partial<Firm> = {}): Firm {
  const f: Firm = {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    root: 'roman',
    motto: '',
    slot: 200 + id.length,
    balance,
    status: 'active',
    negativeSince: null,
    bankruptAt: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
  openDb().prepare('INSERT OR REPLACE INTO firms (id, json) VALUES (?, ?)').run(f.id, JSON.stringify(f));
  record('firm.seeded', { firm: f });
  return f;
}

let floors = 0;
/** One floor earned on `repo` by `agentId`'s tower. */
export function floorOn(agentId: string, repo: string): void {
  layEarnedFloor(agentTowerId(agentId), {
    id: `floor-${floors++}`,
    repo,
    kind: 'pr',
    refs: ['#1'],
    title: 'Fix the widgets',
    at: '2026-11-02T00:00:00.000Z',
    era: 'glass',
    size: 'small',
    lines: 10,
    claude: false,
    founding: false,
    url: null,
  });
}

/** The genome a voyage's champion was bred to. */
export function championBody(id: string, over: Partial<Genome> = {}): Genome {
  return {
    id,
    name: 'Sharp One',
    model: LOCAL,
    instructions: 'Be SHARP: read the failing test first, then answer right.',
    tools: [],
    workflow: { shape: 'self-check' },
    memory: { examples: 2 },
    ...over,
  };
}

/**
 * A finished voyage on `arena` whose champion `genome` was bred from the
 * seeded agent `starter` (generation 1) through `mid` (generation 2), and
 * beat every seeded local agent (`claim`), as voyages.ts writes it: the
 * voyages row and its `voyage.ended`.
 */
export function bredVoyage(o: {
  id: string;
  arena: string;
  repo: string;
  starter: string;
  genome: string;
  endedAt: string;
  commissionedBy?: string | null;
  claim?: boolean;
  status?: VoyageView['status'];
  body?: Genome;
}): VoyageView {
  const row = (genome: string, name: string, generation: number, parents: string[], mean: number) => ({ genome, name, generation, mean, lo: mean - 0.1, hi: mean + 0.1, parents, scored: true });
  const view: VoyageView = {
    id: o.id,
    arena: o.arena,
    status: o.status ?? 'done',
    generation: VOYAGE.generations,
    of: VOYAGE.generations,
    runs: { done: 96, of: 96 },
    commissionedBy: o.commissionedBy ?? null,
    scores: [
      row(o.starter, 'Starter', 1, [], 0.2),
      row('mid', 'Middle', 2, [o.starter], 0.5),
      row(o.genome, 'Sharp One', 3, ['mid'], 0.9),
      row(o.genome, 'Sharp One', 4, [], 0.9),
    ],
    promoted: [
      { child: 'mid', parent: o.starter, diff: 0.3, lo: 0.1, hi: 0.5 },
      { child: o.genome, parent: 'mid', diff: 0.4, lo: 0.2, hi: 0.6 },
    ],
    sealed: { value: 0.9, lo: 0.8, hi: 1, n: 3 },
    credits: 4,
    startedAt: new Date(Date.parse(o.endedAt) - 3 * 24 * 3600_000).toISOString(),
    endedAt: o.endedAt,
    repo: o.repo,
    reason: null,
    pausedAt: null,
    champion: { genome: o.genome, name: 'Sharp One', model: LOCAL, generation: 3, parents: ['mid'], body: o.body ?? championBody(o.genome) },
    vsLocal: [{ agent: o.starter, name: 'Starter', diff: 0.7, lo: 0.5, hi: 0.9 }],
    claim: o.claim ?? true,
    notCompared: NOT_COMPARED,
  };
  openDb().prepare('INSERT OR REPLACE INTO voyages (id, json) VALUES (?, ?)').run(view.id, JSON.stringify(view));
  record('voyage.ended', { voyageId: view.id, voyage: view, repo: o.repo });
  return view;
}

/** A graduate as Task 27 will make it: an adapter that beat its base on a sealed race. */
export function graduate(id: string, over: Partial<Graduate> = {}): Graduate {
  return {
    id,
    model: 'mlx:qwen2.5-coder-7b-lora-1' as ModelRef,
    base: 'qwen2.5-coder:7b',
    loraId: 'lora-1',
    sealed: { value: 0.7, lo: 0.6, hi: 0.8, n: 20 },
    baseSealed: { value: 0.5, lo: 0.4, hi: 0.6, n: 20 },
    vsBase: { diff: 0.2, lo: 0.05, hi: 0.35 },
    examples: 140,
    arenas: ['arena-1'],
    at: '2026-11-11T03:00:00.000Z',
    agentId: null,
    ...over,
  };
}
