/**
 * Jobs: where work comes from and the only place a job's status changes.
 *
 * A job comes from an issue someone labelled with one of the repo's tier
 * labels, from his direct request (spec 7.1), or from the baseline harness
 * proposal (ruling 23), which waits for his click. Nothing the city writes
 * (its PRs, merges and comments, all signed with CITY_MARKER) ever posts a
 * job: an issue that has ever held a job is never posted again, and issues
 * marked done or failed are skipped (docs/SELF_RECURSION_GUARDRAILS.md).
 *
 * `transition()` checks every move against LEGAL_MOVES (Task 1), records
 * `job.changed` and emits it. On `merged` and on the final `failed` it writes
 * back to the issue through gh; those writes run after the move and never
 * undo it (settleJobEffects() waits for them).
 */
import { randomUUID } from 'node:crypto';

import { legalMove, MAX_ATTEMPTS, TIER_LABELS, TIER_VALUE, tierFromLabels } from '../../shared/market-rules.js';
import type { Job, JobSource, JobStatus, Repo, Tier } from '../../shared/types.js';
import { openDb } from '../db.js';
import { emit } from '../events.js';
import { addLabel, commentIssue, type Issue, issueState, openIssues } from '../github.js';
import { record } from '../ledger.js';

/** The city signs what it writes with this; an issue whose body carries it is never a job. */
export const CITY_MARKER = '[palimpsest]';
export const DONE_LABEL = 'palimpsest:done';
export const FAILED_LABEL = 'palimpsest:failed';
export const HARNESS_TITLE = 'Add a baseline test and build harness';

const HARNESS_BODY = [
  'This repo has no test command or no build command, so the city cannot check work on it and push mode stays off.',
  '',
  'Scope:',
  '- **',
  '',
  '- [ ] A test command that runs the repo\'s tests and exits non-zero on failure',
  '- [ ] A build command that builds the repo from a clean checkout',
  '- [ ] Both are documented in the README',
].join('\n');

/** Statuses a job never leaves. A `failed` job is final only once its attempts are spent. */
const TERMINAL: JobStatus[] = ['merged', 'closed', 'withdrawn'];
/** Statuses with a run that must be killed before the job is withdrawn. */
const LIVE: JobStatus[] = ['running', 'inspecting'];

// ------------------------------------------------------------------ storage

function save(j: Job): void {
  openDb()
    .prepare('INSERT OR REPLACE INTO jobs (id, repo, status, json) VALUES (?, ?, ?, ?)')
    .run(j.id, j.repo, j.status, JSON.stringify(j));
}

export function job(id: string): Job | null {
  const row = openDb().prepare('SELECT json FROM jobs WHERE id = ?').get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as Job) : null;
}

export interface JobFilter {
  repo?: string;
  status?: JobStatus | JobStatus[];
  source?: JobSource;
}

/** Jobs in the order they were posted, optionally filtered. */
export function listJobs(filter: JobFilter = {}): Job[] {
  const rows = openDb().prepare('SELECT json FROM jobs').all() as Array<{ json: string }>;
  const statuses = filter.status === undefined ? null : Array.isArray(filter.status) ? filter.status : [filter.status];
  return rows
    .map((r) => JSON.parse(r.json) as Job)
    .filter((j) => (filter.repo === undefined || j.repo === filter.repo)
      && (statuses === null || statuses.includes(j.status))
      && (filter.source === undefined || j.source === filter.source))
    .sort((a, b) => a.postedAt.localeCompare(b.postedAt) || a.id.localeCompare(b.id));
}

function newId(): string {
  return `job-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

// ------------------------------------------------------------------ parsing

const HEADING = /^\s*(?:#{1,6}\s*)?([A-Za-z][A-Za-z ]*?)\s*:?\s*$/;
const SCOPE_HEADING = /^\s*(?:#{1,6}\s*scope\s*:?|scope\s*:)\s*(.*)$/i;
const BULLET = /^\s*(?:[-*+]|\d+\.)\s+/;
const CHECKBOX = /^\s*[-*+]\s+\[[ xX]\]\s+(.+?)\s*$/;

/** A glob from one list item: its first word, when that word looks like a path (prose is dropped). */
function cleanGlob(s: string): string {
  const word = s.replace(BULLET, '').replace(/`/g, '').trim().split(/\s+/)[0] ?? '';
  return /[/*.]/.test(word) ? word : '';
}

/**
 * The job's scope: the globs under a `Scope:` heading (`Scope:`, `## Scope`,
 * or inline `Scope: a/**, b/*`), one per line or comma separated, up to the
 * next blank line or heading. `['**']` when the body names none.
 */
export function parseScope(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => SCOPE_HEADING.test(l));
  if (start < 0) return ['**'];
  const globs: string[] = [];
  const take = (text: string) => {
    for (const part of text.split(',')) {
      const g = cleanGlob(part);
      if (g) globs.push(g);
    }
  };
  take(SCOPE_HEADING.exec(lines[start])![1]);
  let seenItem = globs.length > 0;
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) {
      if (seenItem) break;
      continue;
    }
    if (/^\s*#/.test(line) || (!BULLET.test(line) && HEADING.test(line) && line.trim().endsWith(':'))) break;
    if (CHECKBOX.test(line)) break;
    take(line);
    seenItem = true;
  }
  return globs.length ? globs : ['**'];
}

/** The acceptance criteria: every markdown checkbox in the body, else the title alone. */
export function parseAcceptance(body: string, title = ''): string[] {
  const items = body
    .split(/\r?\n/)
    .map((l) => CHECKBOX.exec(l)?.[1])
    .filter((s): s is string => !!s);
  return items.length ? items : [title.trim()].filter(Boolean);
}

// ------------------------------------------------------------------ posting

function makeJob(p: {
  repo: string;
  source: JobSource;
  issue: number | null;
  url: string | null;
  title: string;
  body: string;
  tier: Tier;
  status: JobStatus;
  scope?: string[];
  acceptance?: string[];
}): Job {
  return {
    id: newId(),
    repo: p.repo,
    source: p.source,
    issue: p.issue,
    url: p.url,
    title: p.title,
    body: p.body,
    scope: p.scope ?? parseScope(p.body),
    acceptance: p.acceptance ?? parseAcceptance(p.body, p.title),
    tier: p.tier,
    value: TIER_VALUE[p.tier],
    status: p.status,
    attempts: 0,
    postedAt: new Date().toISOString(),
    bidsCloseAt: null,
    awardedBid: null,
    runId: null,
    floorId: null,
    closedAt: null,
    excludedFirms: [],
    haltedFrom: null,
  };
}

function post(j: Job): Job {
  save(j);
  const kind = j.status === 'proposed' ? 'job.proposed' : 'job.posted';
  record(kind, { job: j });
  emit(kind, { job: j });
  return j;
}

export interface PollDeps {
  /** Kills a job's live run (Task 13); the job is withdrawn after it returns. */
  kill?: (jobId: string) => Promise<void> | void;
}

/**
 * Reads the repo's tier labels, one query each (ruling 3), and posts a job for
 * every new issue; then withdraws the jobs whose issue was closed. Returns the
 * jobs posted. Read only on GitHub. A failed listing throws before anything
 * is posted or withdrawn, so a partial answer never reads as closed issues.
 */
export async function pollJobs(repo: Repo, deps: PollDeps = {}): Promise<Job[]> {
  const base = repo.label || 'palimpsest';
  const lists = await Promise.all(TIER_LABELS(base).map((label) => openIssues(repo.fullName, label)));

  const seen = new Map<number, Issue>();
  for (const issue of lists.flat()) {
    const prior = seen.get(issue.number);
    seen.set(issue.number, prior ? { ...issue, labels: [...new Set([...prior.labels, ...issue.labels])] } : issue);
  }

  const mine = listJobs({ repo: repo.fullName }).filter((j) => j.source === 'issue');
  const held = new Set(mine.map((j) => j.issue));
  const posted: Job[] = [];
  for (const issue of [...seen.values()].sort((a, b) => a.number - b.number)) {
    if (held.has(issue.number)) continue;
    if (issue.body.includes(CITY_MARKER)) continue;
    if (issue.labels.includes(DONE_LABEL) || issue.labels.includes(FAILED_LABEL)) continue;
    const tier = tierFromLabels(issue.labels, base);
    if (!tier) continue;
    posted.push(
      post(makeJob({
        repo: repo.fullName,
        source: 'issue',
        issue: issue.number,
        url: issue.url,
        title: issue.title,
        body: issue.body,
        tier,
        status: 'open',
      })),
    );
  }

  for (const j of mine) {
    if (j.issue === null || seen.has(j.issue) || !withdrawable(j)) continue;
    if ((await issueState(repo.fullName, j.issue)) !== 'CLOSED') continue;
    if (LIVE.includes(j.status) || (j.status === 'awarded' && j.runId)) await deps.kill?.(j.id);
    const now = job(j.id);
    if (now && withdrawable(now)) transition(now, 'withdrawn');
  }
  return posted;
}

/**
 * A job a closed issue may withdraw. A waiting job (or one halted from
 * waiting) is left to merge detection (Task 16): its PR closing the issue is
 * how a merge usually looks from here.
 */
function withdrawable(j: Job): boolean {
  if (j.status === 'waiting' || (j.status === 'halted' && j.haltedFrom === 'waiting')) return false;
  return legalMove(j.status, 'withdrawn');
}

export interface ManualJobInput {
  repo: string;
  title: string;
  body?: string;
  tier?: Tier;
  scope?: string[];
  acceptance?: string[];
}

/** His direct request (spec 7.1): an open job with no issue behind it. */
export function postManualJob(input: ManualJobInput): Job {
  const title = input.title?.trim() ?? '';
  if (!title) throw new Error('a job needs a title');
  const connected = openDb().prepare('SELECT json FROM repos WHERE full_name = ?').get(input.repo) as
    | { json: string }
    | undefined;
  if (!connected || !(JSON.parse(connected.json) as Repo).connected) throw new Error(`${input.repo} is not connected`);
  const body = input.body ?? '';
  return post(makeJob({
    repo: input.repo,
    source: 'manual',
    issue: null,
    url: null,
    title,
    body,
    tier: input.tier ?? 'normal',
    status: 'open',
    scope: input.scope?.length ? input.scope : undefined,
    acceptance: input.acceptance?.length ? input.acceptance : undefined,
  }));
}

/**
 * Proposes the baseline harness job (ruling 23). Idempotent per repo: while a
 * harness job exists that has not merged (proposed, open, in work, failed or
 * dismissed) that job is returned and nothing is recorded, so a dismissal
 * stays dismissed across re-analyses.
 */
export function proposeHarnessJob(repo: Repo): Job {
  const existing = listJobs({ repo: repo.fullName, source: 'harness' }).find((j) => j.status !== 'merged');
  if (existing) return existing;
  return post(makeJob({
    repo: repo.fullName,
    source: 'harness',
    issue: null,
    url: null,
    title: HARNESS_TITLE,
    body: HARNESS_BODY,
    tier: 'normal',
    status: 'proposed',
    scope: ['**'],
  }));
}

function proposed(jobId: string): Job {
  const j = job(jobId);
  if (!j) throw new Error(`no job ${jobId}`);
  if (j.status !== 'proposed') throw new Error(`job ${jobId} is not proposed`);
  return j;
}

/** His click: the proposal goes on the board. */
export function acceptProposed(jobId: string): Job {
  return transition(proposed(jobId), 'open');
}

/** His other click: the proposal is withdrawn and not proposed again. */
export function dismissProposed(jobId: string): Job {
  return transition(proposed(jobId), 'withdrawn');
}

// --------------------------------------------------------------- transitions

/** What the GitHub write-back needs that the job itself does not hold. */
export interface TransitionNote {
  /** The merged PR, commented on the issue. */
  prUrl?: string;
  /** The inspection summary, commented on the issue at the final failure. */
  summary?: string;
}

/**
 * Moves a job. The stored status is the one checked (a stale copy cannot
 * replay a move), against LEGAL_MOVES; `failed > open` also needs
 * attempts below MAX_ATTEMPTS, and leaving `halted` goes back where it came
 * from (ruling 30). A move to `failed` consumes an attempt. Records and emits
 * `job.changed`. Throws `illegal move <from> to <to>` and changes nothing
 * when the move is refused.
 */
export function transition(j: Job, to: JobStatus, patch: Partial<Job> = {}, note: TransitionNote = {}): Job {
  const cur = job(j.id) ?? j;
  const from = cur.status;
  const refuse = () => new Error(`illegal move ${from} to ${to}`);
  if (!legalMove(from, to)) throw refuse();
  if (from === 'failed' && to === 'open' && cur.attempts >= MAX_ATTEMPTS) throw refuse();
  if (from === 'halted' && to === 'waiting' && cur.haltedFrom !== 'waiting') throw refuse();
  if (from === 'halted' && to === 'open' && cur.haltedFrom === 'waiting') throw refuse();

  const { id: _id, status: _status, ...rest } = patch;
  const next: Job = { ...cur, ...rest, id: cur.id, status: to };
  if (to === 'failed' && patch.attempts === undefined) next.attempts = cur.attempts + 1;
  if (to === 'halted') next.haltedFrom = from;
  if (from === 'halted') next.haltedFrom = null;
  const final = TERMINAL.includes(to) || (to === 'failed' && next.attempts >= MAX_ATTEMPTS);
  if (final && !next.closedAt) next.closedAt = new Date().toISOString();

  save(next);
  record('job.changed', { id: next.id, from, to, job: next });
  emit('job.changed', { job: next, from });

  if (next.source === 'issue' && next.issue !== null) {
    if (to === 'merged') effect(writeMerged(next, note));
    else if (to === 'failed' && final) effect(writeFailed(next, note));
  }
  return next;
}

async function writeMerged(j: Job, note: TransitionNote): Promise<void> {
  await addLabel(j.repo, j.issue!, DONE_LABEL);
  const where = note.prUrl ? ` in ${note.prUrl}` : '';
  await commentIssue(j.repo, j.issue!, `Palimpsest merged this${where}.\n\n${CITY_MARKER}`);
}

async function writeFailed(j: Job, note: TransitionNote): Promise<void> {
  await addLabel(j.repo, j.issue!, FAILED_LABEL);
  const summary = note.summary?.trim() || 'No inspection summary was recorded.';
  await commentIssue(
    j.repo,
    j.issue!,
    `Palimpsest tried this ${j.attempts} times and is leaving it to you.\n\nLast inspection: ${summary}\n\n${CITY_MARKER}`,
  );
}

// ------------------------------------------------------------- side effects

const pending = new Set<Promise<void>>();

function effect(p: Promise<void>): void {
  const tracked = p.catch((err: unknown) => {
    console.warn(`palimpsest: issue write-back failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  pending.add(tracked);
  void tracked.finally(() => pending.delete(tracked));
}

/** Waits for every GitHub write-back started by transition() so far. */
export async function settleJobEffects(): Promise<void> {
  while (pending.size) await Promise.all([...pending]);
}
