/**
 * Beagle's library, as Palimpsest sees it (Phase 4 ruling 1): the types of
 * the eight entries Beagle's package exports (`./race`, `./designer`,
 * `./genome`, `./stats`, `./runner`, `./arenas`, `./models`, `./store`).
 *
 * Beagle ships TypeScript sources, and `tsc` checks `.ts` files under
 * `node_modules` (`skipLibCheck` skips only `.d.ts`), so nothing here imports
 * Beagle: `beagle.ts` loads it by a specifier tsc cannot follow and casts it
 * to these types. They are written from Beagle's sources at the pinned
 * commit; a pin that moves rechecks them by the school-beagle tests.
 */
import type { DatabaseSync } from 'node:sqlite';

// ---------------------------------------------------------------- ./models

export type BeagleTurn = { role: 'system' | 'user' | 'assistant'; content: string };
export type BeagleReply = { text: string; json?: unknown; usd: number; ms: number };
export type BeagleProvider = 'claude' | 'ollama' | 'mlx';
export type BeagleCallOptions = { schema?: object; timeoutMs?: number; signal?: AbortSignal };
/** What Beagle calls for every model turn: a program that imports Beagle sets its own with `setDriver`. */
export type BeagleDriver = (provider: BeagleProvider, name: string, turns: BeagleTurn[], o: BeagleCallOptions) => Promise<Omit<BeagleReply, 'json'>>;

export interface BeagleModels {
  /** A usage window or rate limit: Beagle waits and tries again, then stops the race "Claude usage limit". */
  LimitError: new (message?: string) => Error;
  setDriver(d: BeagleDriver | null): void;
  complete(model: string, turns: BeagleTurn[], o?: BeagleCallOptions): Promise<BeagleReply>;
}

// ---------------------------------------------------------------- ./genome

export type BeagleShape = 'single' | 'plan-then-answer' | 'self-check' | 'vote';
export type BeagleGenome = {
  id: string;
  name: string;
  model: string;
  instructions: string;
  tools: string[];
  workflow: { shape: BeagleShape; n?: number };
  memory: { examples: number };
};

export interface BeagleGenomeModule {
  TOOLS: string[];
  validate(x: unknown, tools?: string[]): BeagleGenome;
}

// ---------------------------------------------------------------- ./arenas

export type BeagleToolSpec = {
  name: string;
  describe: string;
  args: object;
  run(args: unknown, ctx?: { task: { id: string; input: unknown } }): Promise<unknown> | unknown;
};

export type BeagleStarter = BeagleGenome;
export type BeagleControl = {
  name: string;
  model: string;
  answer(task: { id: string; input: unknown }): Promise<{ answer: unknown | null; usd: number; ms: number; note: string }>;
};

export type BeagleArena = {
  id: string;
  data: string;
  name: string;
  describe: string;
  answer: object;
  grade(answer: unknown, truth: unknown): number | Promise<number>;
  tools: BeagleToolSpec[];
  show(input: unknown): string;
  valid?(answer: unknown): boolean;
  merge?(answers: unknown[]): unknown;
  example?(truth: unknown): string;
  miss?(answer: unknown, truth: unknown): string;
  selfCheck?(answer: unknown, input: unknown): string;
  maxTurns?: number;
  graderTimeoutMs?: number;
  timesItself?: boolean;
  inBrowser?: boolean;
  brief?(input: unknown): string;
  fromText?(text: string, date: string): unknown;
  kind?: 'geotag' | 'receipts' | 'fixtest' | 'custom';
  starters?(): BeagleStarter[];
  controls?(): BeagleControl[];
};

export type BeagleSplit = 'breeding' | 'race' | 'sealed';

export interface BeagleArenas {
  getArena(id: string): BeagleArena;
  registerArena(a: BeagleArena): void;
  unregisterArena(id: string): void;
  arenaIds(): string[];
  dataOf(id: string): string;
  gradeSafely(a: BeagleArena, answer: unknown, truth: unknown): Promise<number>;
  splitOf(id: string): BeagleSplit;
  startersFor(id: string): BeagleStarter[];
}

// ---------------------------------------------------------------- ./store

export type BeagleTaskRow = { id: string; input: unknown; truth: unknown; split: BeagleSplit };

export interface BeagleStore {
  open(): DatabaseSync;
  close(): void;
  putArena(id: string, name: string): void;
  putTasks(arenaData: string, rows: BeagleTaskRow[]): void;
  json<T>(s: string | null | undefined, fallback: T): T;
}

// ---------------------------------------------------------------- ./race

export type BeagleSettings = {
  capGeneration: number;
  capVoyage: number;
  concurrency: number;
  raceTasks: number;
  population: number;
  generations: number;
  seed: number;
  localOnly: boolean;
  localAgents: boolean;
  view: 'plain' | 'lab';
  reducedMotion: boolean;
};

export type BeagleVoyage = { id: string; arena: string; started_at: string; sealed_hash: string; settings: BeagleSettings; status: string };
export type BeagleScore = { genome: string; mean: number; lo: number; hi: number; usd: number; ms: number; pareto: number; tasks: number; noAnswer: number; within: number };
export type BeagleRaceResult = { complete: boolean; reason?: string; common: string[]; scores: BeagleScore[] };
export type BeagleRaceEvent =
  | { type: 'run'; generation: number; genome: string; task: string; score: number; status: string; usd: number; ms: number }
  | { type: 'progress'; generation: number; done: number; total: number; spent: number }
  | { type: 'waiting'; until: string; reason: string }
  | { type: 'stopped'; generation: number; reason: string }
  | { type: 'finished'; generation: number; result: BeagleRaceResult };
export type BeagleComparison = { child: string; parent: string; diff: number; lo: number; hi: number; tasks: number };
export type BeagleSealedRace = { hash: string; complete: boolean; reason?: string; scores: BeagleScore[]; perTask: Record<string, Record<string, number>> };

export interface BeagleRace {
  sealedHash(arena: string): string;
  startVoyage(arena: string, o?: Partial<BeagleSettings>): BeagleVoyage;
  getVoyage(id: string): BeagleVoyage;
  race(
    voyageId: string,
    generation: number,
    genomes: BeagleGenome[],
    o?: { baselines?: boolean; tasks?: Array<{ id: string; input: string; truth: string | null }>; onEvent?: (e: BeagleRaceEvent) => void; signal?: AbortSignal },
  ): Promise<BeagleRaceResult>;
  finishVoyage(id: string): void;
  compareToParents(voyageId: string, generation: number): BeagleComparison[];
  sealedRace(arenaId: string, genomes: BeagleGenome[], o?: { signal?: AbortSignal; seed?: number }): Promise<BeagleSealedRace>;
}

// ---------------------------------------------------------------- ./designer

export type BeagleBred = {
  next: BeagleGenome[];
  parents: Record<string, string[]>;
  reasons: Record<string, string>;
  refused: Array<{ name: string; why: string }>;
  usd: number;
};

export interface BeagleDesigner {
  /** The model Beagle's designer asks for; the school's driver answers it with the designer setting. */
  DESIGNER: string;
  breed(
    voyageId: string,
    generation: number,
    o: { children: number; elites: number; probe: number; log?: (s: string) => void; designer?: string; signal?: AbortSignal },
  ): Promise<BeagleBred>;
}

// ---------------------------------------------------------------- ./runner

export type BeagleStep = { kind: 'model' | 'tool' | 'note'; input: unknown; output: unknown; usd: number; ms: number };
export type BeagleRunResult = { answer: unknown | null; trace: BeagleStep[]; usd: number; ms: number; status: 'done' | 'no-answer' };

export interface BeagleRunner {
  RunError: new (cause: unknown, spent: number, trace: BeagleStep[]) => Error & { cause: unknown; spent: number; trace: BeagleStep[] };
  run(
    g: BeagleGenome,
    task: { id: string; input: unknown },
    arena: BeagleArena,
    o?: { examples?: Array<{ input: unknown; truth: unknown }>; signal?: AbortSignal },
  ): Promise<BeagleRunResult>;
}

// ---------------------------------------------------------------- ./stats

export interface BeagleStats {
  rng(seed: number): () => number;
  mean(xs: number[]): number;
  /** The seeded 95% percentile bootstrap over 10,000 resamples. */
  bootstrap(xs: number[], seed: number): { lo: number; hi: number };
  pareto(items: Array<{ mean: number; usd: number; ms: number }>): number[];
}

// ---------------------------------------------------------------- the whole

export interface BeagleApi {
  race: BeagleRace;
  designer: BeagleDesigner;
  genome: BeagleGenomeModule;
  stats: BeagleStats;
  runner: BeagleRunner;
  arenas: BeagleArenas;
  models: BeagleModels;
  store: BeagleStore;
}

/** The entries `loadBeagle()` imports, as Beagle's `exports` names them. */
export const BEAGLE_ENTRIES = ['race', 'designer', 'genome', 'stats', 'runner', 'arenas', 'models', 'store'] as const;
