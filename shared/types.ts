export type Era = 'stone' | 'brick' | 'glass' | 'titanium' | 'scifi';
export type RootStyle = 'beauxarts' | 'roman' | 'gothic' | 'pagoda' | 'chicago';
export type FloorSize = 'small' | 'medium' | 'large';

export interface Repo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  language: string | null;
  description: string | null;
  connected: boolean;
  pushMode: boolean;
  root: RootStyle;
  slot: number;
  status: 'idle' | 'analyzing' | 'ready' | 'error';
  error: string | null;
  connectedAt: string | null;
  analyzedAt: string | null;
  /** The market switch for this repo. */
  market: boolean;
  /** The base issue label; tiers are `<label>`, `<label>:low` and `<label>:high`. */
  label: string;
  checks: RepoChecks | null;
  halted: { at: string; reason: string } | null;
  /** Failed inspections in a row; three halts the repo. */
  strikes: number;
  /** The datum: set at the first successful analysis and never moved (ruling 17). */
  joinedAt: string | null;
}

export interface RepoChecks {
  test: string | null;
  typecheck: string | null;
  lint: string | null;
  build: string | null;
  screenshot: string | null;
  preview: { kind: 'vite' | 'next' | 'astro' | 'static'; outDir: string } | null;
  shots: string[];
  install: string | null;
  ecosystems: Array<'npm' | 'python' | 'rust' | 'go'>;
  detected: boolean;
}

export interface Floor {
  id: string;
  repo: string;
  kind: 'pr' | 'commits';
  refs: string[];
  title: string;
  at: string;
  era: Era;
  size: FloorSize;
  lines: number;
  claude: boolean;
  /** True below the datum (history), false for floors earned in the market. */
  founding: boolean;
  url: string | null;
  earned?: EarnedFloor;
}

export interface EarnedFloor {
  jobId: string;
  runId: string;
  agentId: string;
  firmId: string;
  state: 'waiting' | 'lit' | 'scar';
  reverted: boolean;
  /** A note on how the floor was earned, e.g. "merged with his changes" (he added his own commits before merging). */
  note?: string | null;
}

export interface TowerSpec {
  id: string;
  repo: string;
  kind: 'founding' | 'agent';
  root: RootStyle;
  floors: Floor[];
  datumIndex: number;
  firmId?: string;
  agentId?: string;
  dark?: boolean;
  silhouette?: Silhouette;
}

export interface District {
  repo: string;
  index: number;
  origin: { x: number; z: number };
  tower: TowerSpec;
}

export interface UsageWindow {
  usedPercentage: number;
  resetsAt: number;
}

export interface UsageReading {
  at: number;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
}

export interface Settings {
  quality: 'high' | 'medium';
  dayCapPct: number;
  nightCapPct: number;
  hookInstalled: boolean;
  previousStatusLine: unknown | null;
  claudeConcurrency: number;
  localConcurrency: number;
  bidWindowSec: number;
  hardStopPct: number;
  resumeStaleUntil: number | null;
  keepAwake: boolean;
  ollamaHost: string;
  anthropicApi: { enabled: boolean; dailyUsd: number };
}

// ---------------------------------------------------------------- the market

export type Tier = 'low' | 'normal' | 'high';
export type JobSource = 'issue' | 'manual' | 'harness';
export type JobStatus =
  | 'proposed'
  | 'open'
  | 'bidding'
  | 'awarded'
  | 'running'
  | 'inspecting'
  | 'shipping'
  | 'waiting'
  | 'merged'
  | 'failed'
  | 'closed'
  | 'halted'
  | 'withdrawn';

export interface Job {
  id: string;
  repo: string;
  source: JobSource;
  issue: number | null;
  url: string | null;
  title: string;
  body: string;
  scope: string[];
  acceptance: string[];
  tier: Tier;
  value: number;
  status: JobStatus;
  attempts: number;
  postedAt: string;
  bidsCloseAt: string | null;
  awardedBid: string | null;
  runId: string | null;
  floorId: string | null;
  closedAt: string | null;
  excludedFirms: string[];
  haltedFrom: JobStatus | null;
  /** Inspections of this job in a row that no reviewer could read (Task 15); the third halts the job. */
  inconclusive?: number;
  /** Why the job was halted on its own, for his daily brief; cleared on resume. */
  haltNote?: string | null;
}

export type ModelRef = `claude:${string}` | `ollama:${string}` | `anthropic:${string}` | `mlx:${string}`;
export type WorkflowShape = 'single' | 'plan-then-answer' | 'self-check' | 'vote';
export type Silhouette = 'lens' | 'cantilever' | 'needle' | 'plain';

export interface Agent {
  id: string;
  firmId: string;
  name: string;
  model: ModelRef;
  persona: string;
  temperament: string;
  instructions: string;
  tools: string[];
  workflow: { shape: WorkflowShape; n?: number };
  memory: { examples: number };
  lineage: { origin: 'seeded' | 'roster' | 'school'; parents: string[]; generation: number; at: string };
  silhouette: Silhouette;
  maxTurns: number;
  capability: Era;
  bidsOn: Tier[];
  retired: boolean;
  retiredReason: string | null;
  towerIndex: number;
}

export interface Firm {
  id: string;
  name: string;
  root: RootStyle;
  motto: string;
  slot: number;
  balance: number;
  status: 'active' | 'bankrupt';
  negativeSince: string | null;
  bankruptAt: string | null;
  createdAt: string;
}

export interface Bid {
  id: string;
  jobId: string;
  firmId: string;
  agentId: string;
  plan: string;
  price: number;
  confidence: number;
  calibrated: number;
  appraisal: number | null;
  ev: number;
  cost: number;
  at: string;
}

export type RunStage = 'preparing' | 'installing' | 'working' | 'inspecting' | 'shipping' | 'waiting' | 'done';
export type RunOutcome = 'merged' | 'failed' | 'closed' | 'killed' | 'capped' | 'crashed' | null;

export interface RunProgress {
  toolCalls: number;
  filesChanged: number;
  testsRun: number;
  turns: number;
  weightedTokens: number;
  credits: number;
  refusals: number;
}

export interface Run {
  id: string;
  jobId: string;
  bidId: string;
  agentId: string;
  firmId: string;
  repo: string;
  model: ModelRef;
  branch: string;
  dir: string | null;
  baseSha: string | null;
  headSha: string | null;
  stage: RunStage;
  outcome: RunOutcome;
  endedReason: string | null;
  progress: RunProgress;
  startedAt: string;
  endedAt: string | null;
  prNumber: number | null;
  prUrl: string | null;
  mergeSha: string | null;
  inspectionId: string | null;
  scar: boolean;
  unattended: boolean;
  /** The agent's own summary of its change (model output: shown as data, never run). */
  summary?: string | null;
  /**
   * The PR merged, but not as the city shipped it (another head sha or
   * another base branch): not paid, no floor, flagged for his brief.
   */
  mergedWithChanges?: { headRefOid: string | null; baseRefName: string | null; mergeSha: string | null } | null;
  /**
   * The PR merged with commits he added himself on top of what the city
   * pushed (all authored by his GitHub login): it counts as merged and is
   * paid; `headRefOid` is the head that merged.
   */
  hisChanges?: { headRefOid: string; commits: string[] } | null;
}

export type CheckName = 'install' | 'test' | 'typecheck' | 'lint' | 'build' | 'review' | 'scope' | 'design';
export type CheckStatus = 'pass' | 'fail' | 'skipped' | 'preexisting';

export interface CheckResult {
  name: CheckName;
  status: CheckStatus;
  detail: string;
  durationMs: number;
  logPath: string | null;
  testsRun: number | null;
}

export interface Inspection {
  id: string;
  runId: string;
  jobId: string;
  repo: string;
  reviewerAgentId: string | null;
  reviewerFirmId: string | null;
  checks: CheckResult[];
  passed: boolean;
  pushable: boolean;
  design: {
    before: number | null;
    after: number;
    diffOnly: boolean;
    shots: Array<{ route: string; before: string | null; after: string | null }>;
  } | null;
  cost: number;
  at: string;
  /**
   * Why the inspection could not reach a verdict on the agent's work (the
   * diff is too large for any reviewer, or no reviewer could take it).
   * An inconclusive inspection is never a strike and never counts against
   * the firm; the job returns to the board without spending an attempt.
   */
  inconclusive?: string | null;
}

export interface Reputation {
  firmId: string;
  passRate: Record<FloorSize, number | null>;
  passRateAll: number | null;
  brier: number | null;
  durability: number | null;
  overclaim: number;
  score: number;
  samples: number;
  era: Era;
}

export interface BudgetWindow {
  capPct: number;
  cityPct: number;
  usedPct: number | null;
  estimatedPct: number;
  resetsAt: number | null;
}

export interface TreasuryState {
  tokensPerPct: number;
  calibrated: boolean;
  samples: number;
  fiveHour: BudgetWindow;
  sevenDay: BudgetWindow;
  night: { capPct: number; usedPct: number; unattended: boolean };
  interactiveActive: boolean;
  paused: null | { reason: 'stopped' | 'stale' | 'cap' | 'night' | 'hard'; detail: string };
  concurrency: { claude: number; local: number; api: number; claudeMax: number; localMax: number };
  api: { enabled: boolean; spentUsdToday: number; dailyUsd: number };
  keepAwake: { on: boolean; held: boolean };
  citySpent: { today: number; week: number };
}

export interface Quarter {
  firmId: string;
  slot: number;
  origin: { x: number; z: number };
  root: RootStyle;
  dark: boolean;
  towers: TowerSpec[];
}

export type SiteStage = 'crane' | 'framing' | 'inspecting' | 'curing' | 'waiting' | 'teardown' | 'scar';

export interface SiteState {
  repo: string;
  runId: string;
  jobId: string;
  agentId: string;
  firmId: string;
  stage: SiteStage;
  progress: number;
  size: FloorSize;
  since: string;
}

export type TripMode = 'walk' | 'tram' | 'rail' | 'pod' | 'ferry' | 'cab';
export type TripReason = 'bid' | 'job' | 'inspect' | 'home';

export interface Trip {
  id: string;
  agentId: string;
  firmId: string;
  reason: TripReason;
  jobId: string | null;
  from: { x: number; z: number };
  to: { x: number; z: number };
  legs: Array<{ mode: TripMode; path: Array<[number, number, number]>; ms: number }>;
  startedAt: string;
  ms: number;
  endedAt: string | null;
}

export interface ProviderUsage {
  provider: 'claude' | 'ollama' | 'anthropic-api' | 'openai' | 'gemini' | 'mlx';
  status: 'ready' | 'not-found' | 'off' | 'later' | 'unknown';
  windows: Array<{ label: string; usedPct: number | null; resetsAt: number | null }>;
  tokens: { today: number; week: number } | null;
  spendUsd: { today: number; week: number } | null;
  detail: string;
}

export type RunLogLine = {
  at: string;
  kind: 'system' | 'assistant' | 'tool' | 'result' | 'stderr' | 'engine' | 'refused' | 'egress';
  text: string;
  data?: unknown;
};

// ------------------------------------------------------- what the market routes answer

/** A check with its log read inline (capped), never the path it was kept at. */
export type CheckView = Omit<CheckResult, 'logPath'> & { logPath: null; log: string | null };

/** An inspection as the API sends it: logs inline, shots as URLs, no path of this Mac. */
export type InspectionView = Omit<Inspection, 'checks'> & { checks: CheckView[] };

/** A run as the API sends it: the same run without its directory. */
export type RunView = Run & { dir: null };

export interface LedgerRow {
  id: number;
  at: string;
  kind: string;
  data: unknown;
}

export interface Award {
  chosen: Bid | null;
  why: string;
  satOut: Array<{ agentId: string; reason: string }>;
}

export interface JobDetail {
  job: Job;
  bids: Bid[];
  award: Award | null;
  runs: RunView[];
  inspections: InspectionView[];
  ledger: LedgerRow[];
}

export type FirmView = Firm & { reputation: Reputation; agents: Agent[] };

export interface CreditRow {
  id: number;
  at: string;
  firmId: string | null;
  runId: string | null;
  kind: string;
  amount: number;
  usd: number | null;
}

export type FirmDetail = FirmView & { jobs: Job[]; credits: CreditRow[] };

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

export interface AgentDetail {
  agent: Agent;
  firm: Firm | null;
  tower: TowerSpec | null;
  runs: RunView[];
  genome: Genome;
  lineage: { agent: Agent['lineage']; parents: Agent[]; children: Agent[] };
}

export type RunDetail = RunView & { job: Job | null; inspection: InspectionView | null };

export type TreasuryView = TreasuryState & {
  balances: Record<string, number>;
  calibration: { tokensPerPct: number; samples: number; calibrated: boolean };
};

export interface LiveView {
  sites: SiteState[];
  trips: Trip[];
}

export interface ReportView {
  day: string;
  markdown: string;
  data: unknown;
}

export type ManualJobBody = {
  repo: string;
  title: string;
  body?: string;
  tier?: Tier;
  scope?: string[];
  acceptance?: string[];
};
