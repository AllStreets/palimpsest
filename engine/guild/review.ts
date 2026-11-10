/**
 * The reviewer (Task 15): an agent of another active firm reads the
 * committed change against the job before anything ships.
 *
 * The pick: the working agents of every active firm other than the
 * worker's, highest firm reputation first (ties by firm, tower and agent
 * id), and the first whose model can take a `review` sub-lease of the
 * run's own work lease (ruling 28). A sub-lease in the run's own pool
 * needs no slot, so a review never waits on the run slots; one in another
 * pool (a local reviewer for a Claude run) needs a free slot there. When
 * the Claude pool is paused, a local reviewer is picked.
 *
 * Money (ruling 6): the call is the city's spend, charged once as a
 * credits row of kind `review` with no firm. review() moves no money to
 * the reviewer's firm; the treasury pays the reviewer's share once, on
 * `inspection.done` (Task 17).
 *
 * The diff is the agent's output: every backend's review prompt quotes it
 * as data (quote.ts), never as instructions.
 */
import type { Agent, CheckResult, Job, Run } from '../../shared/types.js';
import { entries } from '../ledger.js';
import { chargesItself } from '../market/anthropic-api.js';
import { callPaused, charge, REVIEW_ESTIMATE, type Lease } from '../market/budget.js';
import { firm as storedFirm, listAgents, listFirms } from '../market/firms.js';
import type { Usage } from '../market/provider.js';
import { providerFor } from '../market/providers.js';
import { reputation } from '../market/reputation.js';

/** Reviewers tried in turn when a call fails for its own reasons (not a stop). */
const MAX_TRIES = 3;

/**
 * The most diff, in characters, each backend's reviewer reads whole: below
 * every cut a prompt makes (claude.ts and the API at 200,000 characters)
 * and, for Ollama, inside a default context window. A diff longer than a
 * reviewer's window is never handed to it cut: a padded diff could push the
 * real change past what the reviewer sees.
 */
export const REVIEW_WINDOW = { claude: 150_000, anthropic: 150_000, ollama: 12_000, mlx: 12_000 } as const;

export function reviewWindow(model: string): number {
  const prefix = model.slice(0, model.indexOf(':')) as keyof typeof REVIEW_WINDOW;
  return REVIEW_WINDOW[prefix] ?? 12_000;
}

export const TOO_LARGE = 'too large to review';

const ZERO: Usage = { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 };

/** Working agents of active firms other than the worker's, best reputation first. */
export function reviewerCandidates(run: Pick<Run, 'firmId'>): Agent[] {
  const log = entries();
  const firms = listFirms().filter((f) => f.status === 'active' && f.id !== run.firmId);
  const score = new Map(firms.map((f) => [f.id, reputation(f.id, log).score]));
  return listAgents()
    .filter((a) => !a.retired && score.has(a.firmId) && storedFirm(a.firmId)?.status === 'active')
    .sort(
      (a, b) =>
        (score.get(b.firmId) ?? 0) - (score.get(a.firmId) ?? 0) ||
        a.firmId.localeCompare(b.firmId) ||
        a.towerIndex - b.towerIndex ||
        a.id.localeCompare(b.id),
    );
}

/**
 * The reviewer for `run`: the best candidate whose model can take a review
 * call now. With the run's `lease`, "can" means a review sub-lease is
 * granted (it is released at once); without one, that the treasury would
 * let the call start. Null when nobody can.
 */
export function pickReviewer(run: Pick<Run, 'firmId'>, lease?: Lease): Agent | null {
  for (const a of reviewerCandidates(run)) {
    if (lease) {
      const sub = lease.sub('review', a.model, REVIEW_ESTIMATE);
      if ('signal' in sub) {
        sub.release();
        return a;
      }
    } else if (!callPaused(a.model, REVIEW_ESTIMATE)) {
      return a;
    }
  }
  return null;
}

function cleanUsage(u: unknown): Usage {
  const o = (u && typeof u === 'object' ? u : {}) as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
  return { weightedTokens: n(o.weightedTokens), seconds: n(o.seconds), usd: n(o.usd), credits: n(o.credits) };
}

const add = (a: Usage, b: Usage): Usage => ({
  weightedTokens: a.weightedTokens + b.weightedTokens,
  seconds: a.seconds + b.seconds,
  usd: a.usd + b.usd,
  credits: a.credits + b.credits,
});

export interface ReviewOutcome {
  result: CheckResult;
  reviewerAgentId: string | null;
  reviewerFirmId: string | null;
  usage: Usage;
  /** Credits the city was charged for the review calls. */
  credits: number;
}

/**
 * Has `run`'s committed change (`diff`) reviewed by an agent of another
 * firm, under a `review` sub-lease of the run's work `lease`. The review
 * check passes only when the reviewer approves. A reviewer whose call fails
 * on its own is replaced by the next (up to MAX_TRIES); nobody able to
 * review fails the check. Rejects when the run's lease aborts.
 */
export async function review(run: Run, job: Job, diff: string, checks: CheckResult[], lease: Lease): Promise<ReviewOutcome> {
  const started = Date.now();
  let usage = ZERO;
  let credits = 0;
  const problems: string[] = [];
  let tries = 0;
  const candidates = reviewerCandidates(run);
  const fits = candidates.filter((a) => diff.length <= reviewWindow(a.model));
  if (candidates.length && fits.length === 0) {
    const widest = Math.max(...candidates.map((a) => reviewWindow(a.model)));
    return {
      result: {
        name: 'review',
        status: 'fail',
        detail: `The change is ${TOO_LARGE}: its diff is ${diff.length} characters and the widest reviewer reads ${widest} whole. No reviewer is shown a cut diff.`,
        durationMs: 0,
        logPath: null,
        testsRun: null,
      },
      reviewerAgentId: null,
      reviewerFirmId: null,
      usage,
      credits,
    };
  }
  for (const a of fits) {
    if (tries >= MAX_TRIES) break;
    if (lease.signal.aborted) throw new Error('The review was stopped.');
    const sub = lease.sub('review', a.model, REVIEW_ESTIMATE);
    if (!('signal' in sub)) {
      problems.push(`${a.id}: ${sub.reason.detail}`);
      continue;
    }
    tries++;
    const provider = providerFor(a.model);
    const bill = (u: Usage, floor: number) => {
      // The Anthropic backend writes its own credits rows; never twice.
      if (provider.kind === 'anthropic' && chargesItself) return;
      credits += charge({ runId: run.id, firmId: null, model: a.model, kind: 'review', usage: u, unattended: run.unattended, lease: sub, minCredits: floor });
    };
    try {
      const out = await provider.review({ job, agent: a, persona: a.persona, diff, acceptance: job.acceptance, checks }, sub.signal);
      const u = cleanUsage(out.usage);
      usage = add(usage, u);
      bill(u, 0);
      const concerns = Array.isArray(out.concerns) ? out.concerns.filter((c) => typeof c === 'string').map((c) => c.slice(0, 500)).slice(0, 20) : [];
      const notes = String(out.notes ?? '').slice(0, 2000);
      const detail = [`${a.name} (${a.firmId}) ${out.approve ? 'approved' : 'did not approve'}.`, notes, ...concerns.map((c) => `Concern: ${c}`)].filter(Boolean).join('\n');
      return {
        result: { name: 'review', status: out.approve === true ? 'pass' : 'fail', detail: detail.slice(0, 4000), durationMs: Date.now() - started, logPath: null, testsRun: null },
        reviewerAgentId: a.id,
        reviewerFirmId: a.firmId,
        usage,
        credits,
      };
    } catch (err) {
      // A failed or stopped Claude call still spent his plan: at least the estimate.
      bill(ZERO, a.model.startsWith('claude:') ? REVIEW_ESTIMATE : 0);
      if (sub.signal.aborted || lease.signal.aborted) throw err;
      problems.push(`${a.id}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      sub.release();
    }
  }
  const why = problems.length ? ` (${problems.join('; ')})` : '';
  return {
    result: { name: 'review', status: 'fail', detail: `No reviewer from another firm could review the change${why}.`.slice(0, 4000), durationMs: Date.now() - started, logPath: null, testsRun: null },
    reviewerAgentId: null,
    reviewerFirmId: null,
    usage,
    credits,
  };
}
