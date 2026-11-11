/**
 * The interface every model backend implements: claude -p (Task 9), the
 * Ollama and Anthropic API tool loops (Task 10) and the fake provider used
 * by tests and the sample economy (Task 6). Types only; frozen from Task 1.
 */
import type { Agent, CheckResult, Job, ModelRef, Repo, RepoChecks, RunLogLine, RunProgress } from '../../shared/types.js';

export interface Usage {
  weightedTokens: number;
  seconds: number;
  usd: number;
  credits: number;
}

export interface PlanInput {
  job: Job;
  agent: Agent;
  persona: string;
  repoSummary: string;
  examples: string[];
}

export interface WorkInput {
  job: Job;
  agent: Agent;
  persona: string;
  runId: string;
  dir: string;
  branch: string;
  plan: string | null;
  examples: string[];
  log: (line: RunLogLine) => void;
  onProgress: (p: Partial<RunProgress>) => void;
  signal: AbortSignal;
  caps: { maxTurns: number; maxMinutes: number; maxCredits: number };
}

export interface ReviewInput {
  job: Job;
  agent: Agent;
  persona: string;
  diff: string;
  acceptance: string[];
  checks: CheckResult[];
}

/** Base64 PNGs per route, before and after. */
export interface JudgeInput {
  bar: string;
  before: string[];
  after: string[];
  diff: string | null;
}

/**
 * The README audit (Phase 3 ruling 13): a read-only session over a fresh
 * clone at `baseSha`, with the README and docs already read from that
 * commit, whose answer is structured by `AUDIT_SCHEMA` (engine/audit/schema.ts).
 * No agent: the surveyor's persona is the engine's own prompt.
 */
export interface AuditInput {
  repo: Repo;
  auditId: string;
  dir: string;
  baseSha: string;
  readme: { path: string; text: string } | null;
  docs: Array<{ path: string; text: string }>;
  checks: RepoChecks | null;
  model: ModelRef;
  log: (line: RunLogLine) => void;
  onProgress: (p: Partial<RunProgress>) => void;
  signal: AbortSignal;
  caps: { maxTurns: number; maxMinutes: number; maxCredits: number };
}

/** `answer` is the parsed JSON as the model returned it (data, parsed again by `parseAudit()`); `text` its raw text. */
export interface AuditResult {
  answer: unknown;
  text: string;
  usage: Usage;
  ended: 'finished' | 'capped' | 'aborted' | 'crashed';
  reason: string | null;
}

export interface Provider {
  kind: 'claude' | 'ollama' | 'anthropic' | 'fake';
  plan(i: PlanInput, signal: AbortSignal): Promise<{ plan: string; price: number; confidence: number; usage: Usage }>;
  /**
   * `spendsAttempt: false` marks a run that failed for the city's reasons
   * (a login refresh host the egress refused), so the job returns to the
   * board without consuming an attempt (ruling 16; Task 11). Absent means
   * the usual rule.
   */
  work(i: WorkInput): Promise<{ summary: string; usage: Usage; ended: 'finished' | 'capped' | 'aborted' | 'crashed'; reason: string | null; spendsAttempt?: false }>;
  review(i: ReviewInput, signal: AbortSignal): Promise<{ approve: boolean; notes: string; concerns: string[]; usage: Usage }>;
  judge(i: JudgeInput, signal: AbortSignal): Promise<{ before: number | null; after: number; notes: string; usage: Usage }>;
  /** The README audit (Phase 3). Every backend implements it in Phase 3 Task 3; until then each throws `not implemented`. */
  audit(i: AuditInput): Promise<AuditResult>;
}

export type { RunLogLine };
