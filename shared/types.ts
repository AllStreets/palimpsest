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
  /** When the README audit last ended on this repo (Phase 3); null until one has. */
  auditedAt: string | null;
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
  /** The checks he changed by hand, in name order; any other was detected (or is unset). Absent on checks nobody has touched. */
  setByYou?: CheckField[];
}

/** A check he may set on the district page. */
export type CheckField = 'install' | 'test' | 'typecheck' | 'lint' | 'build' | 'screenshot' | 'preview' | 'shots';

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
  /** An agent tower's plot in its quarter (the agent's towerIndex, Task 4): QUARTER_OFFSETS[towerIndex]. */
  towerIndex?: number;
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
  /** Audit a repo once, by itself, when its market is first turned on (Phase 3 decision 1). */
  auditOnConnect: boolean;
  /** The audit's model: `auto` picks Claude when the caps allow, else the largest installed local coder (Phase 3 ruling 5). */
  auditModel: 'auto' | ModelRef;
  /** The most credits one audit may spend before it ends `capped`. */
  auditMaxCredits: number;
  /** Today's limit, set from the brief, in place of `dayCapPct` while `day` is today (Phase 3 ruling 10). */
  todayCapPct: { day: string; pct: number } | null;
}

// ---------------------------------------------------------------- the market

export type Tier = 'low' | 'normal' | 'high';
export type JobSource = 'issue' | 'manual' | 'harness' | 'proposal' | 'brief';
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
  /** The audit finding this job was proposed from (source `proposal`). */
  proposal?: { auditId: string; findingId: string } | null;
  /** The proposal's key (`proposalKey()` or `HARNESS_KEY()`): a key with a job is not proposed again by itself. */
  key?: string | null;
  /** Who withdrew a `withdrawn` job: `him` (a dismissal, a withdraw) holds its key; `city` (reserved: the city withdraws nothing today) frees it. */
  withdrawnBy?: 'him' | 'city' | null;
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
  /** Scope: each changed file outside the job's scope and why, as the detail says it in prose. */
  offenders?: Array<{ path: string; why: string }>;
  /** Review: the reviewer's concerns, one each. */
  concerns?: string[];
  /** Review and design: the reviewer's or the judge's own notes. */
  notes?: string;
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
  /** The limit he set for today from the brief, clamped, while it holds (ruling 10); null otherwise. */
  todayCapPct: { day: string; pct: number } | null;
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
  /** What could not be read while the rest held (Claude: the transcripts trend), in a sentence with its reason. */
  trouble?: string;
  /** Ollama: the models installed, as `ollama list` names them. */
  models?: string[];
  /** Ollama: the host it was asked at (Settings' ollamaHost). */
  host?: string;
}

// ---------------------------------------------------------------- Phase 3: the audit, the brief, milestones and the tour

export type Verdict = 'REAL' | 'PARTIAL' | 'MISSING' | 'STUBBED' | 'BROKEN';

/** One piece of evidence for a finding, checked against the base commit (`verified`), never the working tree. */
export interface Evidence {
  file: string;
  line: number | null;
  note: string;
  verified: boolean;
}

/** What the audit proposes the market build for a finding; `jobId` once posted as a `proposed` job. */
export interface Proposal {
  key: string;
  title: string;
  body: string;
  scope: string[];
  acceptance: string[];
  tier: Tier;
  jobId: string | null;
}

export interface Finding {
  id: string;
  claim: string;
  source: { file: string; line: number | null };
  verdict: Verdict;
  tested: boolean;
  evidence: Evidence[];
  /** No piece of evidence verified against the base commit: the finding gets no proposal. */
  unverified: boolean;
  proposal: Proposal | null;
}

export type AuditStatus = 'waiting' | 'preparing' | 'installing' | 'reading' | 'done' | 'failed' | 'capped' | 'killed' | 'crashed';
export type AuditTrigger = 'connect' | 'demand' | 'brief';

export interface Audit {
  id: string;
  repo: string;
  model: ModelRef | null;
  trigger: AuditTrigger;
  baseSha: string | null;
  status: AuditStatus;
  waitingReason: string | null;
  startedAt: string;
  endedAt: string | null;
  endedReason: string | null;
  findings: Finding[];
  counts: Record<Verdict, number>;
  unverified: number;
  claimsRead: number;
  credits: number;
  unattended: boolean;
  markdownPath: string | null;
}

/** An audit as the API sends it: the page inline, its proposals as jobs, no path of this Mac. */
export type AuditView = Omit<Audit, 'markdownPath'> & { markdown: string | null; proposals: Job[] };

export type BriefItemKind = 'merged' | 'failed' | 'pr' | 'proposal' | 'halt' | 'revert' | 'note' | 'audit' | 'audit-due' | 'usage' | 'stale' | 'milestone' | 'tour';
export type BriefAction = 'accept' | 'tier' | 'dismiss' | 'why' | 'diff' | 'fly' | 'retry' | 'resume' | 'open-pr' | 'cap' | 'audit' | 'tour';

export interface BriefItem {
  id: string;
  kind: BriefItemKind;
  repo: string | null;
  title: string;
  text: string;
  at: string;
  tier: Tier | null;
  refs: { jobId?: string; runId?: string; inspectionId?: string; prUrl?: string; floorId?: string; auditId?: string; milestoneId?: string; firmId?: string };
  actions: BriefAction[];
  acted: { action: BriefAction; at: string } | null;
}

export interface Brief {
  day: string;
  since: string;
  firstOpen: boolean;
  due: boolean;
  lead: string;
  usage: { fiveHour: BudgetWindow; sevenDay: BudgetWindow; todayCapPct: number | null; paused: TreasuryState['paused'] };
  sections: { waiting: BriefItem[]; overnight: BriefItem[]; recommendations: BriefItem[]; city: BriefItem[] };
  tour: { week: string; stops: number } | null;
}

export type MilestoneKind = 'skyline' | 'founding-skyline' | 'revival' | 'ribbon';

export interface Milestone {
  id: string;
  kind: MilestoneKind;
  towerId: string;
  repo: string | null;
  firmId: string | null;
  agentId: string | null;
  floorId: string | null;
  at: string;
  until: string | null;
  lit: boolean;
  title: string;
  detail: string;
}

export interface TourStop {
  kind: 'merged' | 'scar' | 'skyline' | 'revival' | 'ribbon' | 'firm' | 'hire' | 'exchange';
  towerId: string | null;
  repo: string | null;
  floorId: string | null;
  agentId: string | null;
  firmId: string | null;
  title: string;
  caption: string;
  at: string;
  dwell: number;
  glide: number;
}

export interface Tour {
  week: string;
  from: string;
  to: string;
  stops: TourStop[];
  seconds: number;
}

export type RunLogLine = {
  at: string;
  kind: 'system' | 'assistant' | 'tool' | 'result' | 'stderr' | 'engine' | 'refused' | 'egress';
  text: string;
  data?: unknown;
};

// ------------------------------------------------------- what the market routes answer

/** A check with its log read inline (capped), never the path it was kept at. */
export type CheckView = Omit<CheckResult, 'logPath'> & { log: string | null };

/** An inspection as the API sends it: logs inline, shots as URLs, no path of this Mac. */
export type InspectionView = Omit<Inspection, 'checks'> & { checks: CheckView[] };

/** A run as the API sends it: the same run without its directory (the key is absent, as in the event stream). */
export type RunView = Omit<Run, 'dir'>;

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
  /** Agents that sat out of the job's current round, with why (the round still taking bids included). */
  satOut: Array<{ agentId: string; firmId: string; reason: string; at: string }>;
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

/** One movement on a firm's books, with the balance it left (a `credits.moved` entry, signed for the firm). */
export interface BookRow {
  at: string;
  kind: string;
  delta: number;
  balance: number;
  runId: string | null;
  jobId: string | null;
  agentId: string | null;
  /** The job's title, when the movement was for a job. */
  title: string | null;
}

/** A round a firm bid in: its best bid of the round, and the bid that won it (null when nobody did). */
export interface FirmRound {
  jobId: string;
  title: string;
  repo: string;
  tier: Tier;
  value: number;
  at: string;
  won: boolean;
  bid: Bid;
  winner: Bid | null;
  /** What became of the work when the firm won: the run's outcome, `live` while it runs, null before it starts. */
  outcome: RunOutcome | 'live' | null;
}

/** The firm's reputation after each resolved bid (and each revert), oldest first. */
export interface ReputationPoint {
  at: string;
  /** What moved it: a resolved bid that passed or failed, or a merge reverted. */
  event: 'pass' | 'fail' | 'revert';
  score: number;
  passRate: number | null;
  /** 1 minus the Brier score so far: higher is better calibrated. */
  calibration: number | null;
  durability: number | null;
  samples: number;
}

/** A specialist hired, or a dark tower bought or sold. `other` is the firm on the other side of a sale. */
export interface FirmDeal {
  kind: 'hired' | 'bought' | 'sold';
  at: string;
  agentId: string;
  other: string | null;
  price: number;
}

export type FirmDetail = FirmView & {
  jobs: Job[];
  /** What the firm opened with (its `firm.seeded` balance), and whether older movements were left out of `books`. */
  opening: number;
  truncated: boolean;
  books: BookRow[];
  rounds: FirmRound[];
  reputationLine: ReputationPoint[];
  deals: FirmDeal[];
};

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
  /** Its firm's reputation, the calibration its bids are trimmed by. */
  reputation: Reputation | null;
  /** The firm whose root its tower stands in now: its own, or the buyer of its dark tower. */
  towerFirmId: string | null;
}

export type RunDetail = RunView & { job: Job | null; inspection: InspectionView | null };

export type TreasuryView = TreasuryState & {
  balances: Record<string, number>;
  calibration: { tokensPerPct: number; samples: number; calibrated: boolean };
  /** Either window's estimate at or over this stops all Claude work. */
  hardStopPct: number;
  /** His newest usage reading: when it was taken (ms) and whether it is too old to trust. Null before the first. */
  reading: { at: number; stale: boolean } | null;
  /** While a resume is carrying the city past a stale reading: until when (ms). */
  resumedUntil: number | null;
  /** The city's model calls today (from local midnight) and over the last seven days. */
  spend: { today: SpendPeriod; week: SpendPeriod };
  /** Days with a daily report, newest first. */
  reports: string[];
  /**
   * The runs under way on the books (no end yet), by pool: the same runs the
   * job board and the run pages show. `concurrency` is the slots the runner
   * holds for them, which the sample economy's runs never take.
   */
  underWay: { total: number; claude: number; local: number; api: number };
};

/** One row of the spend tables: what its calls cost, in credits, and how many entries make it up. */
export interface SpendRow {
  credits: number;
  usd: number;
  entries: number;
}

export interface SpendPeriod {
  from: string;
  to: string;
  total: number;
  /** By the firm charged; `firmId` null is the city's own reviews and design checks. */
  firms: Array<SpendRow & { firmId: string | null }>;
  /** By model; `windowPct` is the share of a five-hour window for a Claude model, else null. */
  models: Array<SpendRow & { model: string; windowPct: number | null }>;
}

/** One credits row, as a spend row opens to it. */
export interface CreditEntry {
  id: number;
  at: string;
  kind: string;
  firmId: string | null;
  runId: string | null;
  jobId: string | null;
  model: string;
  credits: number;
  usd: number | null;
  unattended: boolean;
}

export interface CreditEntries {
  rows: CreditEntry[];
  count: number;
  total: number;
}

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
