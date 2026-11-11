/**
 * The market's rules as pure functions and constants: tiers, the award, the
 * reputation score and era, firm money and the job transition table. Shared
 * by the engine and the UI; imports nothing from engine/.
 */
import type { Era, JobStatus, Repo, RepoChecks, Reputation, Tier } from './types.js';

/** A job's value (the bid ceiling) by tier, in credits (ruling 3). */
export const TIER_VALUE: Record<Tier, number> = { low: 20, normal: 60, high: 150 };

/** The three issue labels that post a job: normal, low and high. */
export function TIER_LABELS(base = 'palimpsest'): [string, string, string] {
  return [base, `${base}:low`, `${base}:high`];
}

const TIER_ORDER: Tier[] = ['low', 'normal', 'high'];

/** The job's tier from an issue's labels: null when it carries no tier label; with more than one, the highest wins. */
export function tierFromLabels(labels: string[], base = 'palimpsest'): Tier | null {
  const [normal, low, high] = TIER_LABELS(base);
  let best = -1;
  for (const label of labels) {
    const tier: Tier | null = label === high ? 'high' : label === normal ? 'normal' : label === low ? 'low' : null;
    if (tier) best = Math.max(best, TIER_ORDER.indexOf(tier));
  }
  return best < 0 ? null : TIER_ORDER[best];
}

/** The overclaim a firm with no resolved bids is charged (ruling 4). */
export const NEW_FIRM_OVERCLAIM = 0.15;
/** How many of a firm's most recent resolved bids its overclaim is measured over. */
export const OVERCLAIM_WINDOW = 20;

export const START_BALANCE = 300;
export const HIRE_FEE = 80;
export const REVIEWER_SHARE = 0.05;
export const MAX_ATTEMPTS = 2;
/** Dollars of Anthropic API spend to credits, for the firm's books (ruling 18). */
export const CREDITS_PER_USD = 20;
/** Continuous hours below zero before a firm is bankrupt (ruling 6). */
export const BANKRUPT_HOURS = 72;

/** Rounds away floating point noise (0.9 * 0.8 is 0.7200000000000001), so the books show the numbers people expect. */
function tidy(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/** The calibrated pass probability: stated confidence discounted by the firm's overclaim. */
export function calibrated(confidence: number, overclaim: number): number {
  return tidy(clamp01(confidence) * (1 - clamp01(overclaim)));
}

/** Expected value of a bid to the city: calibrated pass probability times the job's value, minus the price. */
export function expectedValue(calibratedP: number, value: number, price: number): number {
  return tidy(calibratedP * value - price);
}

/**
 * Mean of (confidence - outcome) over the last OVERCLAIM_WINDOW resolved bids
 * (oldest first, most recent last), clamped to [0, 1]. NEW_FIRM_OVERCLAIM when there are none.
 */
export function overclaimOf(resolved: Array<{ confidence: number; passed: boolean }>): number {
  const recent = resolved.slice(-OVERCLAIM_WINDOW);
  if (recent.length === 0) return NEW_FIRM_OVERCLAIM;
  const sum = recent.reduce((s, r) => s + (r.confidence - (r.passed ? 1 : 0)), 0);
  return tidy(clamp01(sum / recent.length));
}

/** score = 0.5 * passRate + 0.3 * (1 - brier) + 0.2 * durability, each unknown term at 0.5 (ruling 5). */
export function reputationScore(r: Pick<Reputation, 'passRateAll' | 'brier' | 'durability'>): number {
  const pass = r.passRateAll ?? 0.5;
  const calibration = r.brier === null ? 0.5 : 1 - r.brier;
  const durability = r.durability ?? 0.5;
  return tidy(0.5 * pass + 0.3 * calibration + 0.2 * durability);
}

export const ERA_ORDER: Era[] = ['stone', 'brick', 'glass', 'titanium', 'scifi'];
/** Lower bound of each era's half-open score range: [0, 0.35) stone ... [0.8, 1] scifi. */
const ERA_FLOORS: Array<[number, Era]> = [
  [0.8, 'scifi'],
  [0.65, 'titanium'],
  [0.5, 'glass'],
  [0.35, 'brick'],
  [0, 'stone'],
];

/** The era a score earns, on half-open ranges, capped at the agent's capability era. */
export function eraForScore(score: number, capability: Era): Era {
  const earned = ERA_FLOORS.find(([min]) => score >= min)?.[1] ?? 'stone';
  return ERA_ORDER.indexOf(earned) <= ERA_ORDER.indexOf(capability) ? earned : capability;
}

/** True once a firm has been negative continuously for BANKRUPT_HOURS. */
export function isBankrupt(negativeSince: string | null, now: number | Date = Date.now()): boolean {
  if (!negativeSince) return false;
  const t = typeof now === 'number' ? now : now.getTime();
  return t - Date.parse(negativeSince) >= BANKRUPT_HOURS * 3600_000;
}

/** A dark tower's sale price in credits. */
export function salePrice(floors: number): number {
  return 2 * floors + 20;
}

/** Hiring needs an active firm, a balance above 400, more open jobs than idle agents and fewer than four towers in the quarter. */
export function canHire(balance: number, openJobs: number, idleAgents: number, towers: number, status: 'active' | 'bankrupt'): boolean {
  return status === 'active' && balance > 400 && openJobs > idleAgents && towers < 4;
}

/** The market fields a repo starts with, also filled in for rows written before Phase 2. */
export function repoMarketDefaults(): Pick<Repo, 'market' | 'label' | 'checks' | 'halted' | 'strikes' | 'joinedAt'> {
  return { market: false, label: 'palimpsest', checks: null, halted: null, strikes: 0, joinedAt: null };
}

/** The registries a job may reach while it installs and works, by the repo's ecosystems (ruling 21). */
export const REGISTRY_HOSTS: Record<'npm' | 'python' | 'rust' | 'go', string[]> = {
  npm: ['registry.npmjs.org'],
  python: ['pypi.org', 'files.pythonhosted.org'],
  rust: ['index.crates.io', 'static.crates.io', 'crates.io'],
  go: ['proxy.golang.org', 'sum.golang.org'],
};

/** Why push mode cannot be on (ruling 23). */
export const PUSH_MODE_NEEDS = 'Push mode needs both a test command and a build command on this repo.';

/** Push mode needs both a test and a build command: null when the checks have both, else the reason. Shared by the engine's gate and the Repos page. */
export function pushModeRefusal(checks: Pick<RepoChecks, 'test' | 'build'> | null): string | null {
  return checks?.test && checks.build ? null : PUSH_MODE_NEEDS;
}

/** Every move a job may make. Anything not listed is refused. */
export const LEGAL_MOVES: Record<JobStatus, JobStatus[]> = {
  proposed: ['open', 'withdrawn'],
  open: ['bidding', 'withdrawn', 'halted'],
  bidding: ['awarded', 'open', 'withdrawn', 'halted'], // open: no positive bid this window
  awarded: ['running', 'open', 'failed', 'withdrawn', 'halted'], // open: killed before it started; failed: crashed in preparing or installing
  running: ['inspecting', 'open', 'failed', 'withdrawn', 'halted'], // open: killed (no attempt); failed: crashed or capped
  inspecting: ['shipping', 'failed', 'open', 'withdrawn', 'halted'], // open: killed mid-inspection
  shipping: ['waiting', 'merged', 'failed', 'open', 'halted'], // open: push rejected twice, no scar
  waiting: ['merged', 'closed', 'withdrawn', 'halted'],
  failed: ['open'], // only while attempts < MAX_ATTEMPTS
  halted: ['open', 'waiting', 'withdrawn'], // resume: back to waiting if halted from waiting (PR still open), else open (ruling 30)
  merged: [],
  closed: [],
  withdrawn: [],
};

export function legalMove(from: JobStatus, to: JobStatus): boolean {
  return LEGAL_MOVES[from]?.includes(to) ?? false;
}
