/**
 * The scripted fake provider (Task 6). Every market test and the sample
 * economy (Task 21) run on it, so no model is ever called and captures
 * never spend his plan (test safety rule 6).
 *
 * Defaults: plan a short plan at 60% of the job's value with confidence
 * 0.7; work writes one file named in the job body inside `i.dir`, logs a
 * few lines and ticks progress, and ends `aborted` as soon as the signal
 * fires; reviews approve; the design judge scores `after 7`.
 *
 * A script replaces any method outright. To vary a default, call it from
 * `fakeDefaults` and change the result.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

import type { Job } from '../../shared/types.js';
import type { JudgeInput, PlanInput, Provider, ReviewInput, RunLogLine, Usage, WorkInput } from './provider.js';

type Awaitable<T> = T | Promise<T>;
type PlanResult = Awaited<ReturnType<Provider['plan']>>;
type WorkResult = Awaited<ReturnType<Provider['work']>>;
type ReviewResult = Awaited<ReturnType<Provider['review']>>;
type JudgeResult = Awaited<ReturnType<Provider['judge']>>;

export type FakeScript = {
  plan?: (i: PlanInput, signal: AbortSignal) => Awaitable<PlanResult>;
  work?: (i: WorkInput) => Awaitable<WorkResult>;
  review?: (i: ReviewInput, signal: AbortSignal) => Awaitable<ReviewResult>;
  judge?: (i: JudgeInput, signal: AbortSignal) => Awaitable<JudgeResult>;
  /** Milliseconds between work steps (the sample economy paces runs with it). Default 0. */
  stepMs?: number;
};

/** The file a fake run writes when the body names none, or names one outside the run dir. */
export const FALLBACK_FILE = 'PALIMPSEST.md';

const usage = (weightedTokens: number, credits: number): Usage => ({ weightedTokens, seconds: 0, usd: 0, credits });

/** A relative path that stays inside the run dir and out of `.git`, or null. */
function safeRelative(candidate: string): string | null {
  if (!candidate || isAbsolute(candidate) || candidate.startsWith('~')) return null;
  const norm = normalize(candidate);
  if (norm === '.' || norm.startsWith('..') || norm.split(sep).includes('..')) return null;
  if (norm.split(sep)[0] === '.git') return null;
  return norm.split(sep).join('/');
}

/**
 * The file named in a job body: the first backticked path, else the first
 * word that looks like a file (a name with an extension). Anything that
 * would leave the run dir or touch `.git` falls back to PALIMPSEST.md.
 */
export function fakeFileName(job: Job): string {
  const ticked = /`([^`\s]+\.[A-Za-z0-9]+)`/.exec(job.body);
  if (ticked) return safeRelative(ticked[1]) ?? FALLBACK_FILE;
  const word = /(?:^|\s)((?:[\w-]+\/)*[\w-]+\.[A-Za-z][A-Za-z0-9]*)(?=[\s,.;:!?)]|$)/.exec(job.body);
  if (word) return safeRelative(word[1]) ?? FALLBACK_FILE;
  return FALLBACK_FILE;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();

function defaultPlan(i: PlanInput): PlanResult {
  const file = fakeFileName(i.job);
  return {
    plan: `1. Read the issue. 2. Write ${file}. 3. Run the checks.`,
    price: Math.round(i.job.value * 0.6 * 100) / 100,
    confidence: 0.7,
    usage: usage(800, 1),
  };
}

async function defaultWork(i: WorkInput, stepMs = 0): Promise<WorkResult> {
  const aborted = (): WorkResult => ({
    summary: 'stopped before finishing',
    usage: usage(0, 0),
    ended: 'aborted',
    reason: 'signal',
  });
  const file = fakeFileName(i.job);
  const steps: (() => void)[] = [
    () => {
      i.log({ at: now(), kind: 'system', text: `fake run ${i.runId} on ${i.branch}` });
      i.onProgress({ turns: 1, toolCalls: 1 });
    },
    () => {
      const target = join(i.dir, file);
      // Belt and braces: the name is already checked, but never write outside the run dir.
      if (relative(i.dir, target).startsWith('..')) throw new Error(`fake provider refused ${file}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `# ${i.job.title}\n\nWritten by the fake provider for run ${i.runId}.\n`);
      const line: RunLogLine = { at: now(), kind: 'tool', text: `write_file ${file}`, data: { path: file } };
      i.log(line);
      i.onProgress({ turns: 2, toolCalls: 2, filesChanged: 1 });
    },
    () => {
      i.log({ at: now(), kind: 'assistant', text: `wrote ${file}` });
      i.onProgress({ turns: 3, toolCalls: 2, filesChanged: 1, weightedTokens: 2400, credits: 4 });
    },
  ];
  for (const step of steps) {
    if (i.signal.aborted) return aborted();
    step();
    await sleep(stepMs);
  }
  if (i.signal.aborted) return aborted();
  i.log({ at: now(), kind: 'result', text: 'finished' });
  return { summary: `Wrote ${file}.`, usage: usage(2400, 4), ended: 'finished', reason: null };
}

function defaultReview(): ReviewResult {
  return { approve: true, notes: 'Looks right.', concerns: [], usage: usage(400, 1) };
}

function defaultJudge(): JudgeResult {
  return { before: null, after: 7, notes: 'Clean and consistent.', usage: usage(300, 1) };
}

/** The defaults, for scripts that want to vary one rather than replace it. */
export const fakeDefaults = {
  plan: defaultPlan,
  work: defaultWork,
  review: defaultReview,
  judge: defaultJudge,
};

export function fakeProvider(script: FakeScript = {}): Provider {
  return {
    kind: 'fake',
    plan: async (i, signal) => (script.plan ? script.plan(i, signal) : defaultPlan(i)),
    work: async (i) => (script.work ? script.work(i) : defaultWork(i, script.stepMs ?? 0)),
    review: async (i, signal) => (script.review ? script.review(i, signal) : defaultReview()),
    judge: async (i, signal) => (script.judge ? script.judge(i, signal) : defaultJudge()),
  };
}
