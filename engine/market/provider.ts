/**
 * The interface every model backend implements: claude -p (Task 9), the
 * Ollama and Anthropic API tool loops (Task 10) and the fake provider used
 * by tests and the sample economy (Task 6). Types only; frozen from Task 1.
 */
import type { Agent, CheckResult, Job, RunProgress } from '../../shared/types.js';

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

export interface Provider {
  kind: 'claude' | 'ollama' | 'anthropic' | 'fake';
  plan(i: PlanInput, signal: AbortSignal): Promise<{ plan: string; price: number; confidence: number; usage: Usage }>;
  work(i: WorkInput): Promise<{ summary: string; usage: Usage; ended: 'finished' | 'capped' | 'aborted' | 'crashed'; reason: string | null }>;
  review(i: ReviewInput, signal: AbortSignal): Promise<{ approve: boolean; notes: string; concerns: string[]; usage: Usage }>;
  judge(i: JudgeInput, signal: AbortSignal): Promise<{ before: number | null; after: number; notes: string; usage: Usage }>;
}

export type RunLogLine = {
  at: string;
  kind: 'system' | 'assistant' | 'tool' | 'result' | 'stderr' | 'engine' | 'refused' | 'egress';
  text: string;
  data?: unknown;
};
