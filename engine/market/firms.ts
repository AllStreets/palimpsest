/**
 * The firms of the market and the agents that work for them (spec 7.2).
 * Five firms are seeded, each with its own temperament, root style and
 * people; a firm can hire a specialist from a hand-written roster. An agent
 * is a genome Beagle can breed (ruling 22) plus its place in the city: a
 * tower in its firm's quarter whose silhouette follows how it works (ruling 25).
 *
 * Seeding happens only from engine/main.ts (test safety rule 9): startServer
 * never calls seedFirms, so no server test ever runs `ollama list`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { salePrice, START_BALANCE } from '../../shared/market-rules.js';
import { silhouetteFor } from '../../shared/silhouette.js';
import type { Agent, Era, Firm, ModelRef, Quarter, RootStyle, Tier, TowerSpec, WorkflowShape } from '../../shared/types.js';
import { openDb } from '../db.js';
import { getRunner } from '../exec.js';
import { quarterOrigin } from '../layout.js';
import { record } from '../ledger.js';
import { earnedFloors, nextSlot } from '../repos.js';

const PERSONA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'personas');

/** The file tools and the command tool every agent is given (Beagle's `tools`). */
export const AGENT_TOOLS = ['read', 'edit', 'write', 'glob', 'grep', 'run'];
/** Worked examples an agent is shown when nothing else is said (Beagle's `memory.examples`). */
export const DEFAULT_EXAMPLES = 3;
/** A quarter has four plots (ruling 6, Task 24). */
export const MAX_TOWERS = 4;
/** Why an agent whose model is missing sits out. */
export const NOT_INSTALLED = 'model not installed';
/** Why the agents of a bankrupt firm stop working; their towers go dark rather than vanish. */
export const BANKRUPT_REASON = 'firm bankrupt';

export interface AgentSeed {
  /** Also the persona file's name: `personas/<id>.md`. */
  id: string;
  name: string;
  /** A trailing `*` means "the first installed tag with this prefix" (resolveModel). */
  model: string;
  capability: Era;
  bidsOn: Tier[];
  examples: number;
  maxTurns: number;
}

export interface FirmSeed {
  firm: { id: string; name: string; root: RootStyle; motto: string };
  temperament: string;
  workflow: { shape: WorkflowShape; n?: number };
  agents: AgentSeed[];
}

export interface RosterSeed extends AgentSeed {
  specialty: 'tests' | 'docs' | 'UI' | 'refactor' | 'migration' | 'performance';
  workflow: { shape: WorkflowShape; n?: number };
}

const ALL_TIERS: Tier[] = ['low', 'normal', 'high'];

export const SEED_FIRMS: FirmSeed[] = [
  {
    firm: { id: 'ashlar-vane', name: 'Ashlar & Vane', root: 'gothic', motto: 'Nothing leaves the yard unread.' },
    temperament: 'careful reviewers',
    workflow: { shape: 'self-check' },
    agents: [
      { id: 'ines-ashlar', name: 'Ines Ashlar', model: 'claude:sonnet', capability: 'scifi', bidsOn: ALL_TIERS, examples: 3, maxTurns: 50 },
      { id: 'teodor-vane', name: 'Teodor Vane', model: 'claude:sonnet', capability: 'scifi', bidsOn: ALL_TIERS, examples: 3, maxTurns: 50 },
    ],
  },
  {
    firm: { id: 'quickset', name: 'Quickset', root: 'chicago', motto: 'Poured by noon, walked on by two.' },
    temperament: 'fast builders',
    workflow: { shape: 'single' },
    agents: [
      { id: 'mack-quickset', name: 'Mack Quickset', model: 'claude:haiku', capability: 'titanium', bidsOn: ['low', 'normal'], examples: 2, maxTurns: 30 },
      { id: 'priya-rao', name: 'Priya Rao', model: 'claude:haiku', capability: 'titanium', bidsOn: ['low', 'normal'], examples: 3, maxTurns: 30 },
      { id: 'ola-bergstrom', name: 'Ola Bergstrom', model: 'claude:sonnet', capability: 'scifi', bidsOn: ALL_TIERS, examples: 3, maxTurns: 40 },
    ],
  },
  {
    firm: { id: 'meridian', name: 'Meridian Works', root: 'beauxarts', motto: 'Fewer jobs, set to the line.' },
    temperament: 'specialists on high tier only',
    workflow: { shape: 'plan-then-answer' },
    agents: [
      { id: 'hal-meridian', name: 'Hal Meridian', model: 'claude:opus', capability: 'scifi', bidsOn: ['high'], examples: 5, maxTurns: 60 },
    ],
  },
  {
    firm: { id: 'kiln', name: 'Kiln Brothers', root: 'roman', motto: 'Slow fire, hard brick.' },
    temperament: 'local heavy lifters',
    workflow: { shape: 'plan-then-answer' },
    agents: [
      { id: 'oskar-kiln', name: 'Oskar Kiln', model: 'ollama:qwen3-coder:30b-a3b*', capability: 'titanium', bidsOn: ['normal', 'high'], examples: 3, maxTurns: 40 },
      { id: 'bruno-kiln', name: 'Bruno Kiln', model: 'ollama:gpt-oss:20b*', capability: 'titanium', bidsOn: ['normal', 'high'], examples: 3, maxTurns: 40 },
    ],
  },
  {
    firm: { id: 'sparrow', name: 'Sparrow & Co', root: 'pagoda', motto: 'Small jobs, done today.' },
    temperament: 'cheap small jobs',
    // Three plan calls per bid, median taken (Task 12); the work itself runs once.
    workflow: { shape: 'vote', n: 3 },
    agents: [
      { id: 'wren-sparrow', name: 'Wren Sparrow', model: 'ollama:qwen2.5-coder:7b*', capability: 'glass', bidsOn: ['low'], examples: 2, maxTurns: 25 },
      // Docs and tests only: her persona says so and she bids accordingly.
      { id: 'juno-pike', name: 'Juno Pike', model: 'ollama:qwen3:1.7b*', capability: 'brick', bidsOn: ['low'], examples: 1, maxTurns: 20 },
    ],
  },
];

/** Specialists a firm can hire in Phase 2 (ruling 6); the school breeds them in Phase 4. Each is hired at most once. */
export const ROSTER: RosterSeed[] = [
  { id: 'dagny-hollis', name: 'Dagny Hollis', specialty: 'tests', model: 'claude:haiku', capability: 'titanium', bidsOn: ['low', 'normal'], examples: 4, maxTurns: 40, workflow: { shape: 'self-check' } },
  { id: 'ottilie-marsh', name: 'Ottilie Marsh', specialty: 'docs', model: 'claude:haiku', capability: 'titanium', bidsOn: ['low', 'normal'], examples: 3, maxTurns: 25, workflow: { shape: 'single' } },
  { id: 'sabine-okoro', name: 'Sabine Okoro', specialty: 'UI', model: 'claude:sonnet', capability: 'scifi', bidsOn: ALL_TIERS, examples: 4, maxTurns: 50, workflow: { shape: 'self-check' } },
  { id: 'anselm-rook', name: 'Anselm Rook', specialty: 'refactor', model: 'claude:sonnet', capability: 'scifi', bidsOn: ['normal', 'high'], examples: 3, maxTurns: 50, workflow: { shape: 'plan-then-answer' } },
  { id: 'marisol-vega', name: 'Marisol Vega', specialty: 'migration', model: 'claude:sonnet', capability: 'scifi', bidsOn: ['normal', 'high'], examples: 3, maxTurns: 50, workflow: { shape: 'plan-then-answer' } },
  { id: 'kenji-mori', name: 'Kenji Mori', specialty: 'performance', model: 'claude:sonnet', capability: 'scifi', bidsOn: ['normal', 'high'], examples: 3, maxTurns: 50, workflow: { shape: 'plan-then-answer' } },
];

/** A stored agent: the Agent itself, plus who bought its tower if its firm went bankrupt and the tower was sold. */
type StoredAgent = Agent & { soldTo?: string };

function publicAgent(a: StoredAgent): Agent {
  const { soldTo: _soldTo, ...rest } = a;
  return rest;
}

/** A persona file: a one-line `line:` header for lists, then the body the agent is given as its instructions. */
export function readPersona(id: string): { line: string; body: string } {
  const text = readFileSync(join(PERSONA_DIR, `${id}.md`), 'utf8');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`persona ${id} has no header`);
  const line = /^line:\s*(.+)$/m.exec(m[1])?.[1].trim();
  if (!line) throw new Error(`persona ${id} has no line`);
  return { line, body: m[2].trim() + '\n' };
}

/**
 * The installed tag `prefix` names: the first tag in `installed` that starts
 * with it (an exact match counts), else null. `qwen3-coder:30b-a3b` resolves
 * to `qwen3-coder:30b-a3b-q4_K_M`.
 */
export function resolveModel(prefix: string, installed: string[]): string | null {
  return installed.find((tag) => tag.startsWith(prefix)) ?? null;
}

/**
 * The Ollama models installed on this Mac, from `ollama list` through the
 * runner. Empty when Ollama is missing, not running or answers with an error.
 */
export async function installedModels(): Promise<string[]> {
  try {
    const { stdout, code } = await getRunner()('ollama', ['list'], { timeoutMs: 10_000 });
    if (code !== 0) return [];
    return stdout
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name): name is string => Boolean(name));
  } catch {
    return [];
  }
}

/** The model an agent seeds with, and whether it can run here. */
function seedModel(spec: string, installed: string[]): { model: ModelRef; installed: boolean } {
  if (!spec.endsWith('*')) return { model: spec as ModelRef, installed: true };
  const bare = spec.slice(0, -1);
  const colon = bare.indexOf(':');
  const provider = bare.slice(0, colon);
  const tag = resolveModel(bare.slice(colon + 1), installed);
  return tag ? { model: `${provider}:${tag}` as ModelRef, installed: true } : { model: bare as ModelRef, installed: false };
}

function saveFirm(f: Firm): void {
  openDb()
    .prepare('INSERT INTO firms (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json')
    .run(f.id, JSON.stringify(f));
}

function saveAgent(a: StoredAgent): void {
  openDb()
    .prepare('INSERT INTO agents (id, firm_id, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET firm_id = excluded.firm_id, json = excluded.json')
    .run(a.id, a.firmId, JSON.stringify(a));
}

function storedAgents(firmId?: string): StoredAgent[] {
  const db = openDb();
  const rows = (
    firmId === undefined
      ? db.prepare('SELECT json FROM agents').all()
      : db.prepare('SELECT json FROM agents WHERE firm_id = ?').all(firmId)
  ) as Array<{ json: string }>;
  const slots = new Map(listFirms().map((f) => [f.id, f.slot]));
  return rows
    .map((r) => JSON.parse(r.json) as StoredAgent)
    .sort((a, b) => (slots.get(a.firmId) ?? 0) - (slots.get(b.firmId) ?? 0) || a.towerIndex - b.towerIndex);
}

function storedAgent(id: string): StoredAgent | null {
  const row = openDb().prepare('SELECT json FROM agents WHERE id = ?').get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as StoredAgent) : null;
}

/** True while an agent's tower stands on its plot: working agents, and the dark (or sold) towers of a bankrupt firm. */
function standing(a: StoredAgent): boolean {
  return !a.retired || a.retiredReason === BANKRUPT_REASON;
}

function makeAgent(
  seed: AgentSeed,
  firmId: string,
  temperament: string,
  workflow: { shape: WorkflowShape; n?: number },
  origin: 'seeded' | 'roster',
  towerIndex: number,
  model: ModelRef,
  installed: boolean,
  at: string,
): Agent {
  const persona = readPersona(seed.id);
  return {
    id: seed.id,
    firmId,
    name: seed.name,
    model,
    persona: persona.line,
    temperament,
    instructions: persona.body,
    tools: [...AGENT_TOOLS],
    workflow: { ...workflow },
    memory: { examples: seed.examples },
    lineage: { origin, parents: [], generation: 0, at },
    silhouette: silhouetteFor(temperament),
    maxTurns: seed.maxTurns,
    capability: seed.capability,
    bidsOn: [...seed.bidsOn],
    retired: !installed,
    retiredReason: installed ? null : NOT_INSTALLED,
    towerIndex,
  };
}

/**
 * Seeds the five firms and their agents. Idempotent, keyed on the firm id: a
 * firm already stored is left exactly as it is. Each new firm takes the next
 * plot (`nextSlot('firm', id)`), so firms stand after every repo already
 * connected, and is recorded as `firm.seeded` with the full firm, each agent
 * as `agent.seeded` with the full agent, so replay can rebuild them.
 * An agent whose model is not in `installed` seeds retired.
 */
export function seedFirms(installed: string[], now: Date = new Date()): void {
  const at = now.toISOString();
  for (const seed of SEED_FIRMS) {
    if (firm(seed.firm.id)) continue;
    const f: Firm = {
      ...seed.firm,
      slot: nextSlot('firm', seed.firm.id),
      balance: START_BALANCE,
      status: 'active',
      negativeSince: null,
      bankruptAt: null,
      createdAt: at,
    };
    saveFirm(f);
    record('firm.seeded', { firm: f });
    seed.agents.forEach((a, i) => {
      const { model, installed: ok } = seedModel(a.model, installed);
      const agent = makeAgent(a, f.id, seed.temperament, seed.workflow, 'seeded', i, model, ok, at);
      saveAgent(agent);
      record('agent.seeded', { agent });
    });
  }
}

/** Every firm, in slot order. */
export function listFirms(): Firm[] {
  const rows = openDb().prepare('SELECT json FROM firms').all() as Array<{ json: string }>;
  return rows.map((r) => JSON.parse(r.json) as Firm).sort((a, b) => a.slot - b.slot);
}

/** Every agent (retired too), or one firm's, by firm slot then tower. */
export function listAgents(firmId?: string): Agent[] {
  return storedAgents(firmId).map(publicAgent);
}

export function firm(id: string): Firm | null {
  const row = openDb().prepare('SELECT json FROM firms WHERE id = ?').get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as Firm) : null;
}

export function agent(id: string): Agent | null {
  const a = storedAgent(id);
  return a ? publicAgent(a) : null;
}

/** The tower id an agent's earned floors are laid on (`earned_floors.tower_id`). */
export function agentTowerId(agentId: string): string {
  return `agent:${agentId}`;
}

/**
 * Every firm's quarter, in slot order: one agent tower per standing agent at
 * its plot in the quarter, in the firm's root with the agent's silhouette,
 * holding the floors the agent has earned (an agent tower has no founding
 * history, so its datum is at 0). A bankrupt firm's towers are dark until
 * sold; a sold tower stays on its plot, re-clad in its buyer's root.
 */
export function quarters(): Quarter[] {
  const firms = listFirms();
  const byId = new Map(firms.map((f) => [f.id, f]));
  return firms.map((f) => {
    const towers: TowerSpec[] = storedAgents(f.id)
      .filter(standing)
      .map((a) => {
        const buyer = a.soldTo ? byId.get(a.soldTo) : undefined;
        const id = agentTowerId(a.id);
        return {
          id,
          // An agent tower belongs to no repo; its floors name the repos they were earned on.
          repo: '',
          kind: 'agent',
          root: buyer ? buyer.root : f.root,
          floors: earnedFloors(id),
          datumIndex: 0,
          firmId: buyer ? buyer.id : f.id,
          agentId: a.id,
          dark: !buyer && a.retired,
          silhouette: a.silhouette,
        };
      });
    return { firmId: f.id, slot: f.slot, origin: quarterOrigin(f.slot), root: f.root, dark: f.status === 'bankrupt', towers };
  });
}

/**
 * Hires the next roster specialist nobody has hired yet into `firmId`, on the
 * lowest free plot of its quarter, and records `agent.hired`. Null when the
 * firm is missing or bankrupt, its quarter already stands four towers, or the
 * roster is spent. The fee and canHire() are the treasury's (Task 17).
 */
export function hire(firmId: string, now: Date = new Date()): Agent | null {
  const f = firm(firmId);
  if (!f || f.status !== 'active') return null;
  const taken = new Set(storedAgents(firmId).filter(standing).map((a) => a.towerIndex));
  if (taken.size >= MAX_TOWERS) return null;
  const seed = ROSTER.find((r) => !storedAgent(r.id));
  if (!seed) return null;
  let towerIndex = 0;
  while (taken.has(towerIndex)) towerIndex += 1;
  const a = makeAgent(seed, firmId, `specialist in ${seed.specialty}`, seed.workflow, 'roster', towerIndex, seed.model as ModelRef, true, now.toISOString());
  saveAgent(a);
  record('agent.hired', { agent: a });
  return a;
}

/** Retires an agent (it stops bidding and working) and records `agent.retired`. An agent already retired is left alone. */
export function retireAgent(agentId: string, reason: string, now: Date = new Date()): Agent | null {
  const a = storedAgent(agentId);
  if (!a) return null;
  if (a.retired) return publicAgent(a);
  const retired: StoredAgent = { ...a, retired: true, retiredReason: reason };
  saveAgent(retired);
  record('agent.retired', { agentId, firmId: a.firmId, reason, at: now.toISOString() });
  return publicAgent(retired);
}

/**
 * Declares a firm bankrupt: every working agent retires and its tower goes
 * dark on its plot. Records `firm.bankrupt`. The 72-hour rule that decides
 * when is the treasury's (Task 17).
 */
export function retireFirm(firmId: string, now: Date = new Date()): Firm | null {
  const f = firm(firmId);
  if (!f) return null;
  if (f.status === 'bankrupt') return f;
  const at = now.toISOString();
  const bankrupt: Firm = { ...f, status: 'bankrupt', bankruptAt: at };
  saveFirm(bankrupt);
  record('firm.bankrupt', { firmId, at });
  for (const a of storedAgents(firmId)) if (!a.retired) retireAgent(a.id, BANKRUPT_REASON, now);
  return bankrupt;
}

/**
 * Sells a bankrupt firm's dark tower to `buyerFirmId`: it stays on its plot
 * and is re-clad in the buyer's root. Records `tower.sold` with the price
 * (ruling 6's `salePrice` of its floors unless the treasury names one). Null
 * when the tower is not dark, already sold, or the buyer cannot buy.
 */
export function sellTower(agentId: string, buyerFirmId: string, price?: number): Agent | null {
  const a = storedAgent(agentId);
  const buyer = firm(buyerFirmId);
  if (!a || !buyer || buyer.status !== 'active' || buyer.id === a.firmId) return null;
  if (a.soldTo || a.retiredReason !== BANKRUPT_REASON || firm(a.firmId)?.status !== 'bankrupt') return null;
  const sold: StoredAgent = { ...a, soldTo: buyer.id };
  saveAgent(sold);
  const cost = price ?? salePrice(earnedFloors(agentTowerId(a.id)).length);
  record('tower.sold', { from: a.firmId, to: buyer.id, price: cost, agentId });
  return publicAgent(sold);
}

/** A firm's working agents with no run in a live stage, by tower. */
export function idleAgents(firmId: string): Agent[] {
  const live = openDb().prepare("SELECT json FROM runs WHERE stage != 'done'").all() as Array<{ json: string }>;
  const busy = new Set(live.map((r) => (JSON.parse(r.json) as { agentId?: string }).agentId));
  return listAgents(firmId).filter((a) => !a.retired && !busy.has(a.id));
}

/** Beagle's genome shape (beagle/src/genome.ts), plus a note when the model had to be mapped. */
export interface Genome {
  id: string;
  name: string;
  model: string;
  instructions: string;
  tools: string[];
  workflow: { shape: WorkflowShape; n?: number };
  memory: { examples: number };
  note?: string;
}

/**
 * The agent as a genome Beagle's validate() accepts (ruling 22). Beagle knows
 * only `claude:` and `ollama:` models, so an `anthropic:` agent maps to
 * `claude:` with a note saying it runs on the API key here.
 */
export function toGenome(a: Agent): Genome {
  const g: Genome = {
    id: a.id,
    name: a.name,
    model: a.model,
    instructions: a.instructions,
    tools: [...a.tools],
    workflow: a.workflow.shape === 'vote' ? { shape: 'vote', n: a.workflow.n } : { shape: a.workflow.shape },
    memory: { examples: a.memory.examples },
  };
  if (a.model.startsWith('anthropic:')) {
    g.model = `claude:${a.model.slice('anthropic:'.length)}`;
    g.note = 'runs on the Anthropic API key in Palimpsest (anthropic:), mapped to claude: for Beagle';
  }
  return g;
}
