/**
 * The school's roster, commissions and hiring (Phase 4 Task 23, ruling 22,
 * Decision 15).
 *
 * - `schoolRoster()`: the specialists the school has made, as roster seeds
 *   of origin `school`: each finished voyage's champion that beat every
 *   seeded local agent on the sealed tasks (`claim`), with its genome, and
 *   each graduate (Task 27's `graduates()`, empty until it lands). A bred
 *   champion takes its era, tiers and turns from its first ancestor, the
 *   seeded agent it was bred from.
 * - `commission(firmId, arenaId, now)`: a firm with at least 400 credits,
 *   an idle agent and a floor on the arena's repo pays the school 120
 *   credits to sail a voyage on a ready arena first. The voyage's id is
 *   chosen here, so the fee names it: one `credits.moved { from: firmId,
 *   to: 'city', amount: 120, reason: 'commission', voyageId }` and one
 *   `voyage.commissioned { voyageId, firmId, fee, arena, repo, voyage }`,
 *   in one write. The voyage is queued (`paused`, no scores yet, carrying
 *   `commissionedBy`), so the tick sails it before any other; voyages.ts
 *   starts it under that id and never records a second commission. The fee
 *   is the firm's whole cost: the voyage's own calls are `school` rows with
 *   `firm_id NULL`, and nothing is refunded if it is paused, capped or makes
 *   no champion. At most one commissioned voyage is live.
 * - `firstRefusal(agentSeedId, now)`: the firm that commissioned a champion's
 *   voyage, for 7 days after it ended, while the champion is unhired.
 * - Hiring (firms.ts `hire()`, through hooks.ts): where the router is
 *   trusted (its card says `trusted`, and the school is on), a firm is
 *   offered the school's seeds before the hand-written roster: a champion
 *   it holds first refusal on first, then the rest the router rates best on
 *   the open jobs; a champion another firm holds first refusal on is not
 *   offered. Where the router is not trusted, Phase 2's hire exactly.
 * - The treasury's daily tick (`commissionDue`): where the router is
 *   trusted and no commissioned voyage is live, the richest firm that may
 *   commission does, on its least recently voyaged arena. A firm still
 *   holding first refusal on a champion it has not hired does not.
 *
 * `installRoster()` (main.ts calls it) puts this behind hooks.ts; with
 * nothing installed the market's roster, hire and daily tick are Phase 2's.
 */
import { randomUUID } from 'node:crypto';

import { START_BALANCE } from '../../shared/market-rules.js';
import { COMMISSION, VOYAGE } from '../../shared/school-rules.js';
import type { Agent, Graduate, Job, VoyageView } from '../../shared/types.js';
import { openDb } from '../db.js';
import { record } from '../ledger.js';
import { agent as storedAgent, agentTowerId, firm, idleAgents, listAgents, listFirms, type RosterSeed } from '../market/firms.js';
import { balances, payCommission } from '../market/treasury.js';
import { earnedFloors, getRepo } from '../repos.js';
import { getSettings } from '../settings.js';
import { arenaInfo, listArenas } from './arenas.js';
import { bidRaw } from './datasets.js';
import { predict, standingOf } from './decisions.js';
import { setRosterHook } from './hooks.js';
import { netCard } from './nets.js';
import { NOT_COMPARED, voyages } from './voyages.js';

const DAY_MS = 24 * 3600_000;

/** A commission that cannot be made now, and why. */
export class CommissionRefused extends Error {
  override name = 'CommissionRefused';
}

const iso = (ms: number) => new Date(ms).toISOString();
const isUnfinished = (v: VoyageView) => v.status === 'sailing' || v.status === 'paused';
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';

/** Whether the router is trusted, as its card says (nets.ts `netCard`); tests may say so instead. */
const byCard = (now: number): boolean => netCard('router', now).status === 'trusted';
let trust: (now: number) => boolean = byCard;
let graduatesOf: () => Graduate[] = () => [];
/** The nets' answer (decisions.ts `predict`); tests may stub the router's. */
let ask: typeof predict = predict;

/** Whether hiring may prefer the school's agents: the school on and the router trusted. Never throws. */
export function routerTrusted(now: number): boolean {
  try {
    return getSettings().school.enabled && trust(now);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- the roster

/** Instructions a graduate is given: its training is in its adapter, so they are plain. */
const GRADUATE_INSTRUCTIONS =
  'You work on his repositories. Read the task and the files it names, find the smallest change that does what it asks, make it, and run the checks before you answer. Say plainly what you changed and why.\n';
const GRADUATE_NAMES = ['Ada Quarry', 'Tamsin Reed', 'Ilse Brand', 'Rafe Collier', 'Noor Hale', 'Esme Thorne', 'Pell Arden', 'Corin Vale'];

function nameFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return GRADUATE_NAMES[h % GRADUATE_NAMES.length];
}

/** The agent id a voyage's champion is hired as. */
export function bredId(genome: string): string {
  return `bred-${slug(genome)}`;
}

/** The agent id a graduate is hired as. */
export function graduateId(graduateIdValue: string): string {
  return `grad-${slug(graduateIdValue)}`;
}

/** The seeded agent a champion was first bred from: walks its parents back to the voyage's first generation. */
function firstAncestor(v: VoyageView, genome: string): string | null {
  const seen = new Set<string>();
  const queue = [genome];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const rows = v.scores.filter((s) => s.genome === id);
    if (rows.some((s) => s.generation === 1)) return id;
    for (const r of rows) queue.push(...r.parents);
  }
  return null;
}

function bredSeed(v: VoyageView): RosterSeed {
  const c = v.champion!;
  const body = c.body!;
  const rootId = firstAncestor(v, c.genome);
  const root: Agent | null = rootId ? storedAgent(rootId) : null;
  const repo = v.repo ?? v.arena;
  return {
    id: bredId(c.genome),
    name: c.name || body.name,
    model: body.model || c.model,
    capability: root?.capability ?? 'glass',
    bidsOn: root ? [...root.bidsOn] : ['low', 'normal'],
    examples: body.memory.examples,
    maxTurns: root?.maxTurns ?? 30,
    specialty: 'bug fixes',
    workflow: body.workflow.shape === 'vote' ? { shape: 'vote', n: body.workflow.n } : { shape: body.workflow.shape },
    origin: 'school',
    persona: {
      line: `Bred by the school on ${repo} in generation ${c.generation}; beat every seeded local agent on its sealed tasks.`,
      body: body.instructions.trim() + '\n',
    },
    parents: [...c.parents],
    generation: c.generation,
  };
}

function graduateSeed(g: Graduate): RosterSeed {
  return {
    id: graduateId(g.id),
    name: nameFor(g.id),
    model: g.model,
    capability: 'glass',
    bidsOn: ['low', 'normal'],
    examples: 3,
    maxTurns: 30,
    specialty: 'bug fixes',
    workflow: { shape: 'single' },
    origin: 'school',
    persona: {
      line: `Graduated from the school: ${g.base} taught on ${g.examples} examples of his verified work, and beat its base on a sealed race.`,
      body: GRADUATE_INSTRUCTIONS,
    },
    parents: [],
    generation: 0,
  };
}

/** Every school seed with the voyage that bred it (null for a graduate), oldest first. */
function made(): Array<{ seed: RosterSeed; voyage: VoyageView | null }> {
  const out: Array<{ seed: RosterSeed; voyage: VoyageView | null }> = [];
  const ids = new Set<string>();
  const add = (seed: RosterSeed, voyage: VoyageView | null) => {
    if (ids.has(seed.id)) return;
    ids.add(seed.id);
    out.push({ seed, voyage });
  };
  for (const v of voyages()) {
    if (v.status !== 'done' || v.claim !== true || !v.champion?.body) continue;
    add(bredSeed(v), v);
  }
  for (const g of graduatesOf()) add(graduateSeed(g), null);
  return out;
}

/** The school's bred specialists and graduates as roster seeds of origin `school`, hired or not, oldest first. */
export function schoolRoster(): RosterSeed[] {
  return made().map((m) => m.seed);
}

function refusalOf(m: { seed: RosterSeed; voyage: VoyageView | null }, now: number): string | null {
  const by = m.voyage?.commissionedBy;
  if (!by || storedAgent(m.seed.id)) return null;
  const ended = Date.parse(m.voyage?.endedAt ?? '');
  if (!Number.isFinite(ended) || now >= ended + COMMISSION.firstRefusalDays * DAY_MS) return null;
  return firm(by)?.status === 'active' ? by : null;
}

/** The firm holding first refusal on a school seed now (it commissioned the voyage, which ended under 7 days ago, and the seed is unhired), or null. */
export function firstRefusal(agentSeedId: string, now: number = Date.now()): string | null {
  const m = made().find((x) => x.seed.id === agentSeedId);
  return m ? refusalOf(m, now) : null;
}

/** The router's mean P(pass) for a seed on the open jobs of its tiers, as `firmId`'s; null with nothing to rate. */
function routerScore(seed: RosterSeed, firmId: string, jobs: Job[]): number | null {
  const rep = standingOf(firmId);
  const as = { workflow: seed.workflow, capability: seed.capability } as Agent;
  const ps: number[] = [];
  for (const j of jobs) {
    if (!seed.bidsOn.includes(j.tier)) continue;
    const got = ask('router', bidRaw(j, null, as, getRepo(j.repo), rep, seed.model));
    if (got && Number.isFinite(got.p)) ps.push(got.p);
  }
  return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : null;
}

/**
 * The school's seeds `firmId` may hire now, best first; empty where the
 * router is not trusted. A seed it holds first refusal on comes first; a
 * seed another firm holds first refusal on is left out; the rest follow by
 * the router's rating on the open jobs (unrated last, oldest first).
 */
export function candidates(firmId: string, now: number): RosterSeed[] {
  if (!routerTrusted(now)) return [];
  const mine: RosterSeed[] = [];
  const open: RosterSeed[] = [];
  for (const m of made()) {
    if (storedAgent(m.seed.id)) continue;
    const holder = refusalOf(m, now);
    if (holder === firmId) mine.push(m.seed);
    else if (holder === null) open.push(m.seed);
  }
  const jobs = (openDb().prepare("SELECT json FROM jobs WHERE status IN ('open', 'bidding')").all() as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Job);
  const rated = open.map((seed, i) => ({ seed, i, p: routerScore(seed, firmId, jobs) }));
  rated.sort((a, z) => (z.p ?? -1) - (a.p ?? -1) || a.i - z.i);
  return [...mine, ...rated.map((r) => r.seed)];
}

// ---------------------------------------------------------------- commissions

/** The repos a firm's agents have earned floors on. */
function floorRepos(firmId: string): Set<string> {
  const out = new Set<string>();
  for (const a of listAgents(firmId)) for (const f of earnedFloors(agentTowerId(a.id))) out.add(f.repo);
  return out;
}

/**
 * Commissions a voyage (ruling 22): `firmId` pays the school COMMISSION.fee
 * to sail on `arenaId` before any other voyage. Throws `CommissionRefused`,
 * with nothing moved or recorded, when the firm is missing or bankrupt, the
 * school is off, the arena is missing, not ready or has a voyage under way,
 * a commissioned voyage is already live, the firm has under 400 credits, no
 * idle agent, or no floor on the arena's repo. Returns the queued voyage.
 */
export function commission(firmId: string, arenaId: string, now: number): VoyageView {
  const f = firm(firmId);
  if (!f) throw new CommissionRefused(`There is no firm ${firmId}`);
  if (f.status !== 'active') throw new CommissionRefused(`${f.name} is bankrupt`);
  if (!getSettings().school.enabled) throw new CommissionRefused('The school is off');
  const info = arenaInfo(arenaId);
  if (!info) throw new CommissionRefused(`There is no arena ${arenaId}`);
  if (info.status !== 'ready') throw new CommissionRefused(`The arena ${arenaId} is ${info.status}, not ready`);
  const all = voyages();
  if (all.some((v) => v.arena === arenaId && isUnfinished(v))) throw new CommissionRefused(`The arena ${arenaId} has a voyage under way`);
  const live = all.find((v) => v.commissionedBy !== null && isUnfinished(v));
  if (live) throw new CommissionRefused(`A commissioned voyage is already under way (${live.id}, for ${firm(live.commissionedBy ?? '')?.name ?? live.commissionedBy})`);
  const balance = balances()[firmId] ?? START_BALANCE;
  if (balance < COMMISSION.minBalance) throw new CommissionRefused(`${f.name} has ${balance} credits; a commission needs at least ${COMMISSION.minBalance} credits`);
  if (idleAgents(firmId).length === 0) throw new CommissionRefused(`${f.name} has no idle agent`);
  if (!floorRepos(firmId).has(info.repo)) throw new CommissionRefused(`${f.name} has no floor on ${info.repo}`);

  // Beagle's own form of a voyage id; voyages.ts starts the voyage in Beagle under it when it first sails
  const id = `v-${iso(now).slice(0, 10)}-${randomUUID().slice(0, 6)}`;
  const raceTasks = Math.max(1, info.tasks.race);
  const view: VoyageView = {
    id,
    arena: info.id,
    status: 'paused',
    generation: 0,
    of: VOYAGE.generations,
    runs: { done: 0, of: VOYAGE.population * raceTasks * VOYAGE.generations },
    commissionedBy: firmId,
    scores: [],
    promoted: [],
    sealed: null,
    credits: 0,
    startedAt: iso(now),
    endedAt: null,
    repo: info.repo,
    reason: `Commissioned by ${f.name}; it sails first on the school's next night`,
    pausedAt: null,
    champion: null,
    vsLocal: [],
    claim: false,
    notCompared: NOT_COMPARED,
  };
  payCommission(firmId, id, now, () => {
    openDb().prepare('INSERT INTO voyages (id, json) VALUES (?, ?)').run(id, JSON.stringify(view));
    const data = { voyageId: id, firmId, fee: COMMISSION.fee, arena: info.id, repo: info.repo, voyage: structuredClone(view) };
    record('voyage.commissioned', data);
    return [['voyage.commissioned', structuredClone(data)]];
  });
  return structuredClone(view);
}

/** The ready arenas `firmId` may commission, least recently voyaged first. */
function arenasFor(firmId: string, all: VoyageView[]): string[] {
  const repos = floorRepos(firmId);
  const busy = new Set(all.filter(isUnfinished).map((v) => v.arena));
  const last = (arena: string) => all.filter((v) => v.arena === arena).reduce((m, v) => (v.startedAt > m ? v.startedAt : m), '');
  return listArenas()
    .filter((a) => a.status === 'ready' && repos.has(a.repo) && !busy.has(a.id))
    .sort((a, z) => last(a.id).localeCompare(last(z.id)) || a.builtAt.localeCompare(z.builtAt))
    .map((a) => a.id);
}

/**
 * The daily tick's commission rule: with the school on, the router trusted
 * and no commissioned voyage live, the richest active firm with at least
 * 400 credits, an idle agent, a ready arena on a repo it has a floor on, and
 * no unhired champion it holds first refusal on, commissions a voyage on
 * the least recently voyaged of those arenas. Null when none does.
 */
export function commissionDue(now: number): VoyageView | null {
  if (!routerTrusted(now)) return null;
  const all = voyages();
  if (all.some((v) => v.commissionedBy !== null && isUnfinished(v))) return null;
  const b = balances();
  const holders = new Set(made().map((m) => refusalOf(m, now)).filter((x): x is string => x !== null));
  const firms = listFirms()
    .filter((f) => f.status === 'active' && (b[f.id] ?? START_BALANCE) >= COMMISSION.minBalance && !holders.has(f.id))
    .sort((x, y) => (b[y.id] ?? 0) - (b[x.id] ?? 0) || x.slot - y.slot);
  for (const f of firms) {
    if (idleAgents(f.id).length === 0) continue;
    const arena = arenasFor(f.id, all)[0];
    if (!arena) continue;
    try {
      return commission(f.id, arena, now);
    } catch (err) {
      if (!(err instanceof CommissionRefused)) throw err;
    }
  }
  return null;
}

// ---------------------------------------------------------------- install

/**
 * Puts the school's roster behind the market's hooks (main.ts calls it once)
 * and returns the uninstall. Tests may say whether the router is trusted
 * (`trusted`, else its card), what the graduates are (`graduates`, else
 * none: Task 27's `graduates()` is wired here when it lands) and what the
 * nets answer (`predict`, else decisions.ts's).
 */
export function installRoster(o: { trusted?: (now: number) => boolean; graduates?: () => Graduate[]; predict?: typeof predict } = {}): () => void {
  trust = o.trusted ?? byCard;
  graduatesOf = o.graduates ?? (() => []);
  ask = o.predict ?? predict;
  setRosterHook({ seeds: schoolRoster, candidates, commissionDue: (now) => void commissionDue(now) });
  return () => {
    setRosterHook(null);
    trust = byCard;
    graduatesOf = () => [];
    ask = predict;
  };
}
