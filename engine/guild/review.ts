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
import { chargesItself } from '../market/anthropic-api.js';
import { callPaused, charge, REVIEW_ESTIMATE, type Lease } from '../market/budget.js';
import { firm as storedFirm, listAgents, listFirms } from '../market/firms.js';
import type { Usage } from '../market/provider.js';
import { providerFor } from '../market/providers.js';
import { reputation, reputationLog } from '../market/reputation.js';
import { homeOf, siteOf, startTrip, whereIs } from '../market/trips.js';

/** Reviewers tried in turn when a call fails for its own reasons (not a stop). */
const MAX_TRIES = 3;

/**
 * The most diff, in characters, each backend's reviewer reads whole: below
 * every cut a prompt makes (claude.ts and the API at 200,000 characters)
 * and, for Ollama, inside the 32,768-token context its review calls ask
 * for (`num_ctx`, ollama.ts), with room for the prompt and the answer. A diff longer than a
 * reviewer's window is never handed to it cut: a padded diff could push the
 * real change past what the reviewer sees.
 */
export const REVIEW_WINDOW = { claude: 150_000, anthropic: 150_000, ollama: 80_000, mlx: 12_000 } as const;

export function reviewWindow(model: string): number {
  const prefix = model.slice(0, model.indexOf(':')) as keyof typeof REVIEW_WINDOW;
  return REVIEW_WINDOW[prefix] ?? 12_000;
}

export const TOO_LARGE = 'too large to review';

/** A model call that may not have read the whole prompt (ollama.ts `TooLargeError`): never a verdict. */
export function isTooLarge(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { tooLarge?: unknown }).tooLarge === true;
}

const ZERO: Usage = { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 };

/* ------------------------------------------------------------------ */
/* Names the change relies on                                          */
/* ------------------------------------------------------------------ */

/**
 * A quoted kebab-case string: what a roster, agent, walker, job kind or
 * route id looks like here ('dagny-hollis', 'tram-leg'). PR #13 shipped a
 * walker id, 'corin-hale', that the sample city's roster does not have.
 */
const QUOTED_ID = /(['"`])([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\1/g;

/**
 * A test file. A test often quotes an id that is meant not to exist, and
 * quotes ids from many rosters at once, so its lines are not checked and it
 * is never taken for a roster.
 */
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

/** Ids a pre-check looks up at most, so one diff full of strings stays cheap. */
export const MAX_NAME_IDS = 200;

/** Names the pre-check reports at most. */
export const MAX_UNFOUND = 10;

/** A name the change relies on that the engine could not find where it should be, and why. */
export interface Unfound {
  id: string;
  why: string;
}

/** The diff's added lines with the file each is in. */
function addedLines(diff: string): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  let file = '';
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) file = '';
    else if (line.startsWith('+++ ')) file = line.slice(4).replace(/^b\//, '');
    else if (line.startsWith('+')) out.push({ file, text: line.slice(1) });
  }
  return out;
}

function quotedIds(text: string): string[] {
  return [...new Set([...text.matchAll(QUOTED_ID)].map((m) => m[2]))];
}

/** The quoted kebab-case ids of the diff's added lines, each with the number of added lines that quote it. */
export function diffIds(diff: string): Map<string, number> {
  const ids = new Map<string, number>();
  for (const l of addedLines(diff)) for (const id of quotedIds(l.text)) ids.set(id, (ids.get(id) ?? 0) + 1);
  return ids;
}

/** The number of added lines that carry `id` as a whole name, quoted or not (a CSS class, a key). */
function linesWith(diff: string, id: string): number {
  const re = new RegExp(`(?<![A-Za-z0-9_-])${id}(?![A-Za-z0-9_-])`);
  return addedLines(diff).filter((l) => re.test(l.text)).length;
}

/**
 * Ids the diff quotes outside its tests that are neither anywhere in the
 * repository before the change (`known`) nor defined by the diff: carried
 * by one added line alone, the line that uses them.
 */
export function unfoundIds(diff: string, known: Set<string>): string[] {
  const used = new Set(addedLines(diff).filter((l) => !TEST_FILE.test(l.file)).flatMap((l) => quotedIds(l.text)));
  return [...used].filter((id) => !known.has(id) && linesWith(diff, id) <= 1).sort();
}

/**
 * Ids quoted in a list beside at least two ids the repository has, missing
 * from most of the source files of the head (not tests, not the list's own)
 * that hold all of those neighbours: a roster the new id was meant to be
 * in and is not. `holders` maps each id to the files of the head that
 * carry it.
 */
export function strangers(diff: string, holders: Map<string, Set<string>>): Unfound[] {
  const out = new Map<string, Unfound>();
  for (const l of addedLines(diff)) {
    const ids = quotedIds(l.text);
    if (ids.length < 3) continue;
    for (const id of ids) {
      const siblings = ids.filter((s) => s !== id && (holders.get(s)?.size ?? 0) > 0);
      if (siblings.length < 2 || out.has(id)) continue;
      const mine = holders.get(id) ?? new Set<string>();
      const rosters = [...holders.get(siblings[0])!].filter((f) => f !== l.file && !TEST_FILE.test(f) && siblings.every((s) => holders.get(s)!.has(f)));
      const missing = rosters.filter((f) => !mine.has(f)).sort();
      // Missing from most of the files its neighbours share: a stray copy elsewhere does not clear it, nor one list without it convict it.
      if (missing.length * 2 > rosters.length) {
        out.set(id, { id, why: `quoted beside ${siblings.map((s) => `'${s}'`).join(', ')} in ${l.file}; ${missing.slice(0, 3).join(', ')} ${missing.length === 1 ? 'has' : 'have'} those and not '${id}'` });
      }
    }
  }
  return [...out.values()];
}

/**
 * The names pre-check (deterministic, before the review): the ids the
 * diff quotes that the repository does not have, and the ids missing from
 * a roster their neighbours are in. `base` and `head` map each id the diff
 * quotes to the files that carry it before and after the change.
 */
export function namesCheck(diff: string, base: Map<string, Set<string>>, head: Map<string, Set<string>>): Unfound[] {
  const known = new Set([...base.entries()].filter(([, f]) => f.size > 0).map(([id]) => id));
  const out: Unfound[] = unfoundIds(diff, known).map((id) => ({ id, why: 'not found in the repository, and the diff does not define it' }));
  for (const s of strangers(diff, head)) if (!out.some((u) => u.id === s.id)) out.push(s);
  return out.slice(0, MAX_UNFOUND);
}

/** A pre-check finding as the review's concern. */
export function unfoundConcern(u: Unfound): string {
  return `The engine could not find '${u.id}': ${u.why}.`.slice(0, 500);
}

/** Working agents of active firms other than the worker's, best reputation first. */
export function reviewerCandidates(run: Pick<Run, 'firmId'>): Agent[] {
  const log = reputationLog();
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

/** What the reviewer is told of a preexisting check that shows no new failures (inspect.ts compareTestCheck). */
export const BASE_STATE_NOTE = "Preexisting, no new failures: this is the base's state, not the change's.";

/**
 * The checks as the reviewer reads them. A check marked preexisting that
 * shows no new failures says so first, so the old failures of the base are
 * not read as the change's (Kiln withheld approval of the vehicle-shade
 * change on "# fail 128", which failed at the base too). The names of the
 * failing tests stay out: the detail already says what the reviewer needs.
 */
export function checksForReviewer(checks: CheckResult[]): CheckResult[] {
  return checks.map(({ failingTests: _names, ...c }) =>
    c.status === 'preexisting' && c.detail.startsWith('No new failures:') ? { ...c, detail: `${BASE_STATE_NOTE} ${c.detail}`.slice(0, 4000) } : c,
  );
}

/**
 * Has `run`'s committed change (`diff`) reviewed by an agent of another
 * firm, under a `review` sub-lease of the run's work `lease`. The review
 * check passes only when the reviewer approves. A reviewer whose call fails
 * on its own is replaced by the next (up to MAX_TRIES); nobody able to
 * review fails the check. Rejects when the run's lease aborts.
 */
export async function review(run: Run, job: Job, diff: string, checks: CheckResult[], lease: Lease, pre: { unfound?: Unfound[] } = {}): Promise<ReviewOutcome> {
  const started = Date.now();
  const unfound = (pre.unfound ?? []).slice(0, MAX_UNFOUND);
  // The engine's own findings stand in the verdict whatever the reviewer answers.
  const found = unfound.map(unfoundConcern);
  let usage = ZERO;
  let credits = 0;
  const problems: string[] = [];
  let tries = 0;
  let tooLarge = false;
  const shown = checksForReviewer(checks);
  const candidates = reviewerCandidates(run);
  const fits = candidates.filter((a) => diff.length <= reviewWindow(a.model));
  if (candidates.length && fits.length === 0) {
    const widest = Math.max(...candidates.map((a) => reviewWindow(a.model)));
    return {
      result: {
        name: 'review',
        status: 'fail',
        detail: [`The change is ${TOO_LARGE}: its diff is ${diff.length} characters and the widest reviewer reads ${widest} whole. No reviewer is shown a cut diff.`, ...found].join('\n').slice(0, 4000),
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
    // The reviewer goes to the site, and home once it has read the change.
    startTrip(a, 'inspect', job.id, whereIs(a), siteOf(run.repo));
    try {
      const out = await provider.review({ job, agent: a, persona: a.persona, diff, acceptance: job.acceptance, checks: shown, ...(unfound.length ? { unfound } : {}) }, sub.signal);
      const u = cleanUsage(out.usage);
      usage = add(usage, u);
      bill(u, 0);
      const said = Array.isArray(out.concerns) ? out.concerns.filter((c) => typeof c === 'string').map((c) => c.slice(0, 500)).slice(0, 20) : [];
      const concerns = [...found, ...said];
      const notes = String(out.notes ?? '').slice(0, 2000);
      const detail = [`${a.name} (${a.firmId}) ${out.approve ? 'approved' : 'did not approve'}.`, notes, ...concerns.map((c) => `Concern: ${c}`)].filter(Boolean).join('\n');
      return {
        result: { name: 'review', status: out.approve === true ? 'pass' : 'fail', detail: detail.slice(0, 4000), durationMs: Date.now() - started, logPath: null, testsRun: null, notes, concerns },
        reviewerAgentId: a.id,
        reviewerFirmId: a.firmId,
        usage,
        credits,
      };
    } catch (err) {
      // A failed or stopped Claude call still spent his plan: at least the estimate.
      bill(ZERO, a.model.startsWith('claude:') ? REVIEW_ESTIMATE : 0);
      if (sub.signal.aborted || lease.signal.aborted) throw err;
      if (isTooLarge(err)) tooLarge = true;
      problems.push(`${a.id}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      sub.release();
      startTrip(a, 'home', job.id, siteOf(run.repo), homeOf(a));
    }
  }
  const why = problems.length ? ` (${problems.join('; ')})` : '';
  const lead = tooLarge ? `The change is ${TOO_LARGE}: a reviewer's prompt filled its context, so it may not have read the change. ` : '';
  return {
    result: { name: 'review', status: 'fail', detail: [`${lead}No reviewer from another firm could review the change${why}.`, ...found].join('\n').slice(0, 4000), durationMs: Date.now() - started, logPath: null, testsRun: null },
    reviewerAgentId: null,
    reviewerFirmId: null,
    usage,
    credits,
  };
}
