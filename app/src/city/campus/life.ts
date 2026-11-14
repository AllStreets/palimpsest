/**
 * The campus's life from the school's real events (Phase 4 Task 37). While a
 * voyage sails, one reading-room bay of the library is lit per genome racing
 * in its current generation, the lamps coming on one after another down the
 * room; the great windows at either end and the lantern on the ridge light
 * with them. A voyage paused for the night (its train pauses) or ended
 * darkens them again over a few seconds. The light is the panes' own
 * instance colours in the campus's one pane draw: no mesh and no light is
 * added. Trained nets and graduates are remembered for the campus's
 * inspector (ui/inspector.ts).
 *
 * Students are unlabelled walkers of the people system (people.ts): a dozen
 * figures in gowns and coats on the walks between the quads, the library,
 * the gate and the dome, each choosing where to go next when it arrives and
 * waiting a little there. They carry no plate and belong to no firm.
 *
 * The parents of a voyage walk in through the gate on trips with reason
 * `school`, and a graduate leaves on its first trip: people.ts ends and
 * starts those trips at the gate (campusTrip); nothing here moves them.
 *
 * The events this consumes, by kind (engine Tasks 22 and 27 record them):
 *   voyage.started    { voyageId, voyage: VoyageView, repo?: string }
 *   voyage.generation { voyageId, voyage: VoyageView }
 *   voyage.ended      { voyageId, voyage: VoyageView }  (status done, capped or failed)
 *   voyage.commissioned { voyageId, firmId, fee }
 *   train.started | train.paused | train.ended { train: TrainState } with train.kind 'voyage'
 *   net.trained       { netVersion: { net, version, trusted, at? } }
 *   graduate.made     { graduate: Graduate }
 * `voyage.racing(v)` is the number of distinct genomes scored in the
 * voyage's current generation, or the population before the first run.
 */
import { VOYAGE } from '../../../../shared/school-rules.js';
import type { Graduate, VoyageView } from '../../../../shared/types.js';
import { rng } from '../tower/kit.js';
import type { People, Walker } from '../people.js';
import type { Campus } from './index.js';

type V3 = [number, number, number];

/** The live voyage as the campus keeps it. */
export interface LifeVoyage {
  id: string;
  arena: string;
  /** The arena's repo when the event names it (`repo` or `arena.repo` on the data), else null. */
  repo: string | null;
  status: VoyageView['status'];
  generation: number;
  of: number;
  runs: { done: number; of: number };
  /** Genomes racing in the current generation: the bays lit. */
  racing: number;
  commissionedBy: string | null;
  startedAt: string;
}

/** A net's newest trained version. */
export interface LifeNet {
  net: string;
  version: number;
  trusted: boolean;
  at: string | null;
}

/** A graduate, as the inspector lists it. */
export interface LifeGraduate {
  id: string;
  model: string;
  base: string;
  agentId: string | null;
  at: string;
  vsBase: { diff: number; lo: number; hi: number };
  examples: number;
}

export interface LifeState {
  /** The voyage sailing or paused now; null when none is live. */
  voyage: LifeVoyage | null;
  /** The newest version of each net that has trained, in the order they first trained. */
  nets: LifeNet[];
  graduates: LifeGraduate[];
}

export const EMPTY_LIFE: LifeState = { voyage: null, nets: [], graduates: [] };

/** The genomes racing in a voyage's current generation; the population before any is scored. */
export function racingGenomes(v: Pick<VoyageView, 'generation' | 'scores'>): number {
  const racing = new Set<string>();
  for (const s of v.scores ?? []) if (s.generation === v.generation) racing.add(s.genome);
  return racing.size > 0 ? racing.size : VOYAGE.population;
}

/** A VoyageView folded to what the campus keeps. */
export function lifeVoyage(v: VoyageView, repo: string | null = null, was: LifeVoyage | null = null): LifeVoyage {
  return {
    id: v.id,
    arena: v.arena,
    repo: repo ?? was?.repo ?? null,
    status: v.status,
    generation: v.generation,
    of: v.of,
    runs: { done: v.runs?.done ?? 0, of: v.runs?.of ?? 0 },
    racing: racingGenomes(v),
    commissionedBy: v.commissionedBy ?? was?.commissionedBy ?? null,
    startedAt: v.startedAt,
  };
}

const LIVE: ReadonlySet<VoyageView['status']> = new Set(['sailing', 'paused']);

/**
 * Folds one of the school's ledger events into the campus's life. Returns
 * the same state when nothing changed, so callers can compare by identity.
 */
export function foldLifeEvent(s: LifeState, e: { type: string; data: unknown }): LifeState {
  const d = (e.data ?? {}) as Record<string, unknown>;
  switch (e.type) {
    case 'voyage.started':
    case 'voyage.generation':
    case 'voyage.ended': {
      const v = d.voyage as VoyageView | undefined;
      if (!v || typeof v !== 'object' || typeof v.id !== 'string') return s;
      const repo = typeof d.repo === 'string' ? d.repo : typeof (d.arena as { repo?: unknown } | undefined)?.repo === 'string' ? ((d.arena as { repo: string }).repo) : null;
      if (!LIVE.has(v.status) || e.type === 'voyage.ended') return s.voyage === null ? s : { ...s, voyage: null };
      return { ...s, voyage: lifeVoyage(v, repo, s.voyage?.id === v.id ? s.voyage : null) };
    }
    case 'voyage.commissioned': {
      if (!s.voyage || d.voyageId !== s.voyage.id || typeof d.firmId !== 'string') return s;
      return { ...s, voyage: { ...s.voyage, commissionedBy: d.firmId } };
    }
    case 'train.started':
    case 'train.paused':
    case 'train.ended': {
      const t = d.train as { id?: string; kind?: string } | undefined;
      if (!t?.id || t.kind !== 'voyage' || !s.voyage) return s;
      // The voyage's night of racing starts or pauses; its end is the voyage's own event.
      const status: VoyageView['status'] = e.type === 'train.started' ? 'sailing' : 'paused';
      return s.voyage.status === status ? s : { ...s, voyage: { ...s.voyage, status } };
    }
    case 'net.trained': {
      const v = d.netVersion as { net?: string; version?: number; trusted?: boolean; at?: string } | undefined;
      if (!v || typeof v.net !== 'string' || typeof v.version !== 'number') return s;
      const row: LifeNet = { net: v.net, version: v.version, trusted: v.trusted === true, at: typeof v.at === 'string' ? v.at : null };
      const i = s.nets.findIndex((n) => n.net === v.net);
      const nets = i < 0 ? [...s.nets, row] : s.nets.map((n, j) => (j === i ? row : n));
      return { ...s, nets };
    }
    case 'graduate.made': {
      const g = d.graduate as Graduate | undefined;
      if (!g || typeof g !== 'object' || typeof g.id !== 'string') return s;
      const row: LifeGraduate = { id: g.id, model: String(g.model), base: g.base, agentId: g.agentId ?? null, at: g.at, vsBase: g.vsBase, examples: g.examples };
      const i = s.graduates.findIndex((x) => x.id === g.id);
      return { ...s, graduates: i < 0 ? [...s.graduates, row] : s.graduates.map((x, j) => (j === i ? row : x)) };
    }
    default:
      return s;
  }
}

/** Which bays a state lights, one level each: the first `racing` of them while the voyage sails, none otherwise. */
export function bayTargets(s: LifeState, bays: number): number[] {
  const n = s.voyage && s.voyage.status === 'sailing' ? Math.min(bays, s.voyage.racing) : 0;
  return Array.from({ length: bays }, (_, i) => (i < n ? 1 : 0));
}

export interface CampusLifeView {
  voyage: LifeVoyage | null;
  /** Each bay's light now, 0 dark to 1 lit, in the library's bay order. */
  bays: number[];
  /** Bays over half lit. */
  lit: number;
  students: number;
}

export interface CampusLifeOptions {
  /** The people (people.ts) the students walk among, or null before the network is laid. */
  people(): People | null;
  quality: 'high' | 'medium';
  /** How many students; a dozen on high, eight on medium by default. */
  students?: number;
  seed?: string;
}

export interface CampusLife {
  /** Folds one of the ledger's events in (foldLifeEvent). */
  apply(e: { type: string; data: unknown }): void;
  /** The state whole, as main.ts keeps it from the ledger and a capture may hold it. */
  setState(s: LifeState): void;
  state(): LifeState;
  /** Per frame: eases the light and walks the students. */
  update(dt: number, clock: number): void;
  view(): CampusLifeView;
  dispose(): void;
}

/** Seconds a bay takes to light or darken, and the stagger between one bay and the next down the room. */
const FADE_S = 2.2;
const STAGGER_S = 0.35;
/** The students: how long one waits where it arrived, and how fast they walk. */
const WAIT_S = { min: 2.5, max: 9 } as const;
const PACE = { min: 1.0, max: 1.45 } as const;
/** An academic gown: near-black wool, long. */
const GOWN: [number, number, number] = [0.022, 0.02, 0.026];

interface Student {
  id: string;
  /** The node it stands at or is walking to. */
  node: number;
  wait: number;
  n: number;
  speed: number;
  coat: [number, number, number] | undefined;
  coatLen: number | undefined;
  rand: () => number;
}

export function campusLife(campus: Campus, opts: CampusLifeOptions): CampusLife {
  let state: LifeState = EMPTY_LIFE;
  const bays = campus.library.bays;
  const level = new Array<number>(bays).fill(0);
  let ends = 0;
  let lantern = 0;
  /** When the current targets were set (the stagger counts from it). */
  let since = 0;
  let clockNow = 0;
  let dirty = true;
  let targets = bayTargets(state, bays);
  let lit = false;

  // ---- the students
  const walks = campus.walks();
  const seed = rng(opts.seed ?? 'students');
  const count = opts.students ?? (opts.quality === 'high' ? 12 : 8);
  const adjacency: number[][] = walks.nodes.map(() => []);
  for (const [a, b] of walks.edges) {
    adjacency[a].push(b);
    adjacency[b].push(a);
  }
  const d2 = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[2] - b[2]);
  /** The shortest way over the walks from one node to another, as the nodes passed. */
  function wayBetween(from: number, to: number): number[] {
    const dist = new Array<number>(walks.nodes.length).fill(Infinity);
    const prev = new Array<number>(walks.nodes.length).fill(-1);
    const open = new Set<number>([from]);
    dist[from] = 0;
    while (open.size) {
      let u = -1;
      for (const i of open) if (u < 0 || dist[i] < dist[u]) u = i;
      open.delete(u);
      if (u === to) break;
      for (const v of adjacency[u]) {
        const nd = dist[u] + d2(walks.nodes[u], walks.nodes[v]);
        if (nd < dist[v]) {
          dist[v] = nd;
          prev[v] = u;
          open.add(v);
        }
      }
    }
    if (dist[to] === Infinity) return [from];
    const out: number[] = [];
    for (let v = to; v !== -1; v = prev[v]) out.unshift(v);
    return out;
  }
  const students: Student[] = [];
  const stands = walks.nodes.length;
  for (let i = 0; i < count && stands > 0; i++) {
    const r = rng(`${opts.seed ?? 'students'}:${i}`);
    const gowned = r() < 0.6;
    students.push({
      id: `student:${i}`,
      node: Math.floor(seed() * stands) % stands,
      wait: seed() * WAIT_S.max,
      n: 0,
      speed: PACE.min + (PACE.max - PACE.min) * r(),
      coat: gowned ? GOWN : undefined,
      coatLen: gowned ? 0.92 : undefined,
      rand: r,
    });
  }
  const walkersNow = new Map<string, Walker>();
  let walkersDirty = false;
  let placed = false;
  /** Sends a student off to a new node over the walks. */
  function send(s: Student): void {
    let to = s.node;
    for (let tries = 0; tries < 6 && to === s.node; tries++) to = Math.floor(s.rand() * stands) % stands;
    const way = wayBetween(s.node, to);
    if (way.length < 2) return;
    s.node = to;
    s.n++;
    s.wait = WAIT_S.min + (WAIT_S.max - WAIT_S.min) * s.rand();
    walkersNow.set(s.id, { id: s.id, key: `${s.id}:${s.n}`, path: way.map((i) => [...walks.nodes[i]] as V3), speed: s.speed, coat: s.coat, coatLen: s.coatLen });
    walkersDirty = true;
  }
  function stepStudents(dt: number): void {
    const people = opts.people();
    if (!people || students.length === 0) return;
    const arrived = new Map(people.walkers().map((w) => [w.id, w.arrived]));
    for (const s of students) {
      // Not yet handed over, or standing where it arrived: wait a little, then go somewhere else.
      const known = walkersNow.has(s.id);
      if (known && arrived.get(s.id) === false) continue;
      s.wait -= dt;
      if (s.wait > 0 && known) continue;
      send(s);
    }
    if (walkersDirty || !placed) {
      people.setWalkers([...walkersNow.values()]);
      walkersDirty = false;
      placed = true;
    }
  }

  function retarget(): void {
    targets = bayTargets(state, bays);
    const on = targets.some((t) => t > 0);
    if (on !== lit) since = clockNow;
    lit = on;
    dirty = true;
  }

  const setState = (s: LifeState): void => {
    if (s === state) return;
    state = s;
    retarget();
  };

  return {
    apply: (e) => setState(foldLifeEvent(state, e)),
    setState,
    state: () => state,
    update(dt, clock) {
      clockNow = clock;
      // The bays: each eases toward its target, the nth starting n staggers after the switch.
      let moving = false;
      const k = Math.min(1, dt / FADE_S);
      for (let i = 0; i < bays; i++) {
        const t = targets[i];
        if (level[i] === t) continue;
        if (clock - since < i * STAGGER_S) {
          moving = true;
          continue;
        }
        const next = t > level[i] ? Math.min(t, level[i] + k) : Math.max(t, level[i] - k);
        level[i] = next;
        moving = true;
      }
      const roomTarget = lit ? 1 : 0;
      if (ends !== roomTarget) {
        ends = roomTarget > ends ? Math.min(1, ends + k) : Math.max(0, ends - k);
        moving = true;
      }
      if (lantern !== roomTarget) {
        lantern = roomTarget > lantern ? Math.min(1, lantern + k * 0.7) : Math.max(0, lantern - k * 0.7);
        moving = true;
      }
      if (moving || dirty) {
        campus.library.set({ bays: level, ends, lantern });
        dirty = false;
      }
      stepStudents(dt);
    },
    view: () => ({
      voyage: state.voyage,
      bays: [...level],
      lit: level.filter((l) => l > 0.5).length,
      students: walkersNow.size,
    }),
    dispose() {
      opts.people()?.setWalkers([]);
      walkersNow.clear();
      students.length = 0;
    },
  };
}
