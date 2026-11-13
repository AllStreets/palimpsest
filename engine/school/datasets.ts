/**
 * The nets' labelled rows, read from what actually happened (Phase 4 Task 8,
 * ruling 8), and why a net has none yet (ruling 29). Read only: nothing here
 * writes the ledger or the database.
 *
 * - Appraiser (`appraiser-pass`, `appraiser-cost`) and router: one row per
 *   awarded bid whose run ended merged, failed or closed (the outcomes
 *   reputation counts; a killed, capped or crashed run, or one he merged
 *   with his own changes, says nothing about the agent). `pass` is 1 for a
 *   merge; `cost` is log1p of every credit charged under the run. The firm's
 *   pass rate and Brier are its reputation from the ledger before the award.
 *   An unawarded bid is never a row.
 * - Durability: one row per merged city run, `survived` 0 at a
 *   `merge.reverted` or `merge.followup` within 30 days of the merge, else 1
 *   once 30 days have passed.
 * - Triage: one row per item of each finished day's first `brief.opened`;
 *   `acted` is 1 when he took any action but dismiss on it that day.
 * - Taste: one row per inspection with the design whose PR he merged or
 *   closed (not one the city merged under a grant), plus one per answered
 *   Understudy pair (read by `understudy.ts`; injectable for tests).
 * - Master: one row per resolved decision, the latest resolution of its key.
 *
 * Ledger kinds later tasks add (`merge.followup`, `decision.resolved`) are
 * read by name, so they are simply empty until those tasks record them.
 * Every real row is `source: 'real'` at weight 1.
 *
 * Distillation (Task 13, ruling 13), only where the targets mean the same:
 * while triage or taste has fewer than `DISTIL.under` real rows, each of its
 * proposal items (triage) or UI decisions (taste) gets a twin, `source:
 * 'distilled'` at weight `DISTIL.weight`, whose label is the master's
 * P(approve) for that work. The master is asked through `DistilPredict`
 * on the inputs `DistilInputs` builds (decisions.ts installs `predict` and
 * `masterInputs` when it loads; without them nothing answers and no row is
 * distilled). The master never learns from its own
 * predictions, and the appraiser, router and durability never get a
 * distilled row. `split()` never holds one out.
 */
import { localDay } from '../../shared/day.js';
import { encode, LANGUAGE_VALUES, type RawRow } from '../../shared/net-features.js';
import { DISTIL, NET_MIN, SURVIVE_DAYS } from '../../shared/school-rules.js';
import type { Agent, Bid, Inspection, Job, NetName, Repo, Run, WorkKind } from '../../shared/types.js';
import { openDb } from '../db.js';
import { paths } from '../home.js';
import { query, type LedgerEntry } from '../ledger.js';
import { creditEntries } from '../market/budget.js';
import { agent } from '../market/firms.js';
import { listJobs } from '../market/jobs.js';
import { reputationLog, resolvedBids } from '../market/reputation.js';
import { listRuns } from '../market/runs.js';
import { PR_CLOSED_REASON } from '../market/ship.js';
import { getRepo, listRepos } from '../repos.js';
import { getSettings } from '../settings.js';
import { understudyCounts, understudyPairs } from './understudy.js';

/** One labelled row as the trainer reads it. */
export interface Row {
  id: string;
  at: string;
  x: number[];
  y: number;
  weight: number;
  source: 'real' | 'distilled';
}

/** An Understudy pair he answered, as Task 10's `understudyPairs()` gives it; `scores` from the local vision judge, null until scored. */
export interface UnderstudyPair {
  id: string;
  at: string;
  pick: 'a' | 'b';
  scores: { a: number; b: number } | null;
}

/** Understudy's live counts (Task 10's `understudyCounts()`); null when the switch is off. */
export interface UnderstudyCounts {
  statements: number;
  pairs: number;
  answered: number;
  /** Why Understudy could not be read (no database, a failed open, a missing table); null when it was read. */
  unreadable: string | null;
}

/** The master's P(approve) for one piece of work and the version that gave it; null is an abstention. Task 14's `predict` has this shape. */
export type DistilPredict = (net: NetName, raw: RawRow) => { p: number; version: number } | null;

/**
 * The master's raw row for a piece of work (Task 14's `masterInputs`): the
 * other nets' outputs on the job and its run, the kind and the repo's
 * approval share, as of `now`. Throws when an input net fails.
 */
export type DistilInputs = (job: Job, run: Run | null, kind: WorkKind, now: number, inspection: Inspection | null) => RawRow;

/** No teacher until decisions.ts installs `predict` with `setDistilPredict`. */
const noTeacher: DistilPredict = () => null;
/** Without `masterInputs`, the master is asked with the kind alone. */
const kindOnly: DistilInputs = (_job, _run, kind) => ({ kind });
let teacher: DistilPredict = noTeacher;
let teacherInputs: DistilInputs = kindOnly;
/** Bumped whenever the teacher changes, so the memo never serves rows a former teacher labelled. */
let teacherGen = 0;

/** Installs the master's predictor for distillation, or `null` for none (no row is distilled), and how its inputs are built. */
export function setDistilPredict(fn: DistilPredict | null, inputs: DistilInputs | null = null): void {
  teacher = fn ?? noTeacher;
  teacherInputs = inputs ?? kindOnly;
  teacherGen += 1;
  memo.clear();
}

/** What other modules provide, injectable; by default the live Understudy reader (empty while its switch is off) and the installed teacher. */
export interface DatasetDeps {
  understudyPairs?: () => UnderstudyPair[];
  understudyCounts?: () => UnderstudyCounts | null;
  predict?: DistilPredict;
}

const NETS: readonly NetName[] = ['appraiser-pass', 'appraiser-cost', 'router', 'durability', 'triage', 'taste', 'master'];
const DAY_MS = 24 * 60 * 60 * 1000;
/** Labels a net needs before it reports anything (ruling 11). */
const NEEDS = NET_MIN.train + NET_MIN.heldOut;

export type Data = Record<string, unknown>;

const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const timeOf = (e: LedgerEntry): string => str((e.data as Data | null)?.at) ?? e.at;
const ms = (s: string | null | undefined): number => (s ? Date.parse(s) : Number.NaN);
const iso = (t: number): string => new Date(t).toISOString();

function real(id: string, at: string, x: number[], y: number): Row {
  return { id, at, x, y, weight: 1, source: 'real' };
}

function byAt(rows: Row[]): Row[] {
  return rows.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

function familyOf(model: string): string {
  return model.split(':')[0] ?? '';
}

function languageOf(lang: string | null | undefined): string | null {
  if (!lang) return null;
  return (LANGUAGE_VALUES as readonly string[]).includes(lang) ? lang : 'other';
}

function words(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/** Jobs by id, read once. */
function jobsById(): Map<string, Job> {
  return new Map(listJobs().map((j) => [j.id, j]));
}

/** Job ids the city acted on under a grant (ruling 14): never his decisions. */
function actedJobs(): Set<string> {
  return new Set(query({ kind: 'autonomy.acted' }).map((e) => str((e.data as Data).jobId) ?? '').filter(Boolean));
}

// ---------------------------------------------------------------- appraiser and router

interface Appraisal {
  bid: Bid;
  run: Run;
  awardAt: string;
  pass: 0 | 1;
  raw: RawRow;
}

function passOf(r: Run): 0 | 1 | null {
  if (r.mergedWithChanges) return null;
  if (r.outcome === 'merged') return 1;
  if (r.outcome === 'failed' || r.outcome === 'closed') return 0;
  return null;
}

/** Rounded as reputation() rounds, so the incremental values equal its own. */
function tidy(x: number): number {
  return Math.round(x * 1e9) / 1e9;
}

/**
 * Each award's firm pass rate and Brier as reputation() gives them on the
 * ledger before that award, in one pass: the awards in ledger order, the
 * resolved bids folded in per firm as the awards pass them. Keyed by the
 * award's ledger id.
 */
export function standingsBefore(awards: ReadonlyArray<{ id: number; firmId: string }>, log: LedgerEntry[] = reputationLog()): Map<number, { passRate: number | null; brier: number | null }> {
  const resolved = resolvedBids(log);
  const sums = new Map<string, { n: number; passed: number; sq: number }>();
  const out = new Map<number, { passRate: number | null; brier: number | null }>();
  let i = 0;
  for (const a of [...awards].sort((x, y) => x.id - y.id)) {
    for (; i < resolved.length && resolved[i].seq < a.id; i++) {
      const r = resolved[i];
      const s = sums.get(r.firmId) ?? { n: 0, passed: 0, sq: 0 };
      s.n += 1;
      if (r.passed) s.passed += 1;
      s.sq += (r.confidence - (r.passed ? 1 : 0)) ** 2;
      sums.set(r.firmId, s);
    }
    const s = sums.get(a.firmId);
    out.set(a.id, s && s.n > 0 ? { passRate: tidy(s.passed / s.n), brier: tidy(s.sq / s.n) } : { passRate: null, brier: null });
  }
  return out;
}

function appraisals(now: number): Appraisal[] {
  const awards = new Map<string, LedgerEntry>();
  for (const e of query({ kind: 'job.awarded' })) {
    const chosen = (e.data as Data).chosen as Bid | null | undefined;
    if (chosen && typeof chosen.id === 'string') awards.set(chosen.id, e);
  }
  if (awards.size === 0) return [];
  const jobs = jobsById();
  const picked: Array<{ run: Run; pass: 0 | 1; award: LedgerEntry; bid: Bid; job: Job }> = [];
  for (const run of listRuns()) {
    if (!run.endedAt || ms(run.endedAt) > now) continue;
    const pass = passOf(run);
    const award = awards.get(run.bidId);
    if (pass === null || !award) continue;
    // The bid as the award chose it: the ledger keeps it whole, so no per-row read of the bids table.
    const bid = (award.data as Data).chosen as Bid;
    const job = jobs.get(run.jobId);
    if (job) picked.push({ run, pass, award, bid, job });
  }
  const standing = standingsBefore(picked.map((p) => ({ id: p.award.id, firmId: p.bid.firmId })));
  const agents = new Map<string, ReturnType<typeof agent>>();
  const repos = new Map<string, ReturnType<typeof getRepo>>();
  const out: Appraisal[] = [];
  for (const { run, pass, award, bid, job } of picked) {
    if (!agents.has(run.agentId)) agents.set(run.agentId, agent(run.agentId));
    if (!repos.has(job.repo)) repos.set(job.repo, getRepo(job.repo));
    const a = agents.get(run.agentId) ?? null;
    // Language and checks are the repo's as it is now, not as it was at the award: a mild drift, accepted.
    const repo = repos.get(job.repo) ?? null;
    const rep = standing.get(award.id) ?? { passRate: null, brier: null };
    out.push({ bid, run, awardAt: timeOf(award), pass, raw: bidRaw(job, bid, a, repo, rep, run.model) });
  }
  return out;
}

/**
 * The appraiser's and the router's raw row for one (job, agent) pair: the
 * job, the repo as it is now, the agent and its firm's standing (`rep`);
 * with a bid, its price, confidence and plan too (the router reads none of
 * them). The rows the nets train on and the rows they are asked about at
 * an award are built here alike.
 */
export function bidRaw(job: Job, bid: Pick<Bid, 'price' | 'confidence' | 'plan'> | null, a: Agent | null, repo: Repo | null, rep: { passRate: number | null; brier: number | null }, model: string): RawRow {
  const c = repo?.checks ?? null;
  return {
    tier: job.tier,
    scope_globs: job.scope.length,
    acceptance_lines: job.acceptance.length,
    source: job.source,
    language: languageOf(repo?.language),
    checks_known: c ? 1 : 0,
    check_test: Boolean(c?.test),
    check_typecheck: Boolean(c?.typecheck),
    check_lint: Boolean(c?.lint),
    check_build: Boolean(c?.build),
    check_screenshot: Boolean(c?.screenshot),
    price_over_value: bid && job.value > 0 ? bid.price / job.value : null,
    confidence: bid ? bid.confidence : null,
    plan_words: bid ? words(bid.plan) : null,
    workflow: a?.workflow.shape ?? null,
    model_family: familyOf(model),
    era: a?.capability ?? null,
    firm_pass_rate: rep.passRate,
    firm_brier: rep.brier,
  };
}

function runCredits(runId: string): number {
  return creditEntries(runId).reduce((s, c) => s + c.credits, 0);
}

// ---------------------------------------------------------------- durability

function durabilityRows(now: number): Row[] {
  const merges = new Map<string, string>();
  for (const e of query({ kind: 'merge.detected' })) {
    const d = e.data as Data;
    const runId = str(d.runId);
    if (runId && !merges.has(runId)) merges.set(runId, str(d.mergedAt) ?? timeOf(e));
  }
  // A revert or follow-up is about its run; only one that names no run falls back to its job.
  const badByRun = new Map<string, number[]>();
  const badByJob = new Map<string, number[]>();
  for (const e of query({ kind: ['merge.reverted', 'merge.followup'] })) {
    const d = e.data as Data;
    const runId = str(d.runId);
    const jobId = str(d.jobId);
    const [map, id] = runId ? [badByRun, runId] : [badByJob, jobId];
    if (!id) continue;
    const list = map.get(id) ?? [];
    list.push(ms(timeOf(e)));
    map.set(id, list);
  }
  const diffs = new Map<string, Data>();
  for (const e of query({ kind: 'run.diff' })) {
    const runId = str((e.data as Data).runId);
    if (runId) diffs.set(runId, e.data as Data);
  }
  const inspections = latestInspections();
  const jobs = jobsById();
  const rows: Row[] = [];
  for (const run of listRuns()) {
    if (run.outcome !== 'merged') continue;
    const mergedAt = merges.get(run.id) ?? run.endedAt;
    const t0 = ms(mergedAt);
    if (!mergedAt || !Number.isFinite(t0) || t0 > now) continue;
    const until = Math.min(t0 + SURVIVE_DAYS * DAY_MS, now);
    const broke = [...(badByRun.get(run.id) ?? []), ...(badByJob.get(run.jobId) ?? [])].some((t) => t >= t0 && t <= until);
    if (!broke && now < t0 + SURVIVE_DAYS * DAY_MS) continue;
    const raw = durabilityRaw(run, jobs.get(run.jobId) ?? null, inspections.get(run.id) ?? null, diffs.get(run.id) ?? null);
    rows.push(real(run.id, iso(t0), encode('durability', raw), broke ? 0 : 1));
  }
  return byAt(rows);
}

/** Durability's raw row for a run: its diff (`run.diff`), the job's tier, its inspection, and whether he changed it. */
export function durabilityRaw(run: Run, job: Job | null, insp: Inspection | null, diff: Data | null): RawRow {
  const files = Array.isArray(diff?.files) ? diff.files.length : run.progress.filesChanged;
  const lines = typeof diff?.lines === 'number' ? diff.lines : null;
  const checks = insp?.checks ?? [];
  const review = checks.find((c) => c.name === 'review');
  return {
    diff_files: files,
    diff_lines: lines,
    tier: job?.tier ?? null,
    model_family: familyOf(run.model),
    checks_passed: checks.filter((c) => c.status === 'pass').length,
    preexisting: checks.filter((c) => c.status === 'preexisting').length,
    design_checked: Boolean(insp?.design),
    review_concerns: review?.concerns?.length ?? 0,
    his_changes: Boolean(run.hisChanges),
  };
}

/** The run's diff as `run.diff` recorded it last, or null. */
export function runDiff(runId: string): Data | null {
  const [e] = query({ kind: 'run.diff', runId, last: true });
  return e ? (e.data as Data) : null;
}

/** The run's latest inspection, from `inspection.done`, or null. */
export function latestInspection(runId: string): Inspection | null {
  const [e] = query({ kind: 'inspection.done', runId, last: true });
  const i = e ? ((e.data as Data).inspection as Inspection | undefined) : undefined;
  return i && i.runId === runId ? i : null;
}

// ---------------------------------------------------------------- distillation

/** A row waiting for the master's soft label: the work it is about, when the job is known. */
interface Pending {
  row: Row;
  kind: WorkKind | null;
  job: Job | null;
  run: Run | null;
  inspection: Inspection | null;
}

/**
 * The distilled twins of `pending` (ruling 13): none once the net has
 * `DISTIL.under` real rows; else one per row the master answers, its label
 * the master's P(approve) for that work, at `DISTIL.weight`. The master
 * reads what it would read before his decision: `masterInputs(job, run)`
 * as of the row's time (the kind alone when the job is gone). An input
 * that fails, or a master that abstains, distils nothing.
 */
function distil(realCount: number, pending: readonly Pending[], teach: DistilPredict | null): Row[] {
  if (!teach || realCount >= DISTIL.under) return [];
  const out: Row[] = [];
  for (const { row, kind, job, run, inspection } of pending) {
    if (!kind) continue;
    let answer: ReturnType<DistilPredict>;
    try {
      answer = teach('master', job ? teacherInputs(job, run, kind, Date.parse(row.at), inspection) : { kind });
    } catch {
      answer = null;
    }
    if (!answer || typeof answer.p !== 'number' || !Number.isFinite(answer.p) || answer.p < 0 || answer.p > 1) continue;
    out.push({ id: `distilled:${row.id}`, at: row.at, x: [...row.x], y: answer.p, weight: DISTIL.weight, source: 'distilled' });
  }
  return out;
}

// ---------------------------------------------------------------- triage

/** The brief item's kind, tier, time and repo, from its id and what it refers to; unknowns null. */
function itemFacts(id: string, jobs: Map<string, Job>, runs: Map<string, Run>, entries: Map<number, LedgerEntry>): { kind: string; tier: string | null; at: string | null; repo: string | null } {
  const colon = id.indexOf(':');
  const kind = colon < 0 ? id : id.slice(0, colon);
  const rest = colon < 0 ? '' : id.slice(colon + 1);
  const fromJob = (j: Job | undefined, at: string | null) => ({ kind, tier: j?.tier ?? null, at, repo: j?.repo ?? null });
  switch (kind) {
    case 'proposal': {
      const j = jobs.get(rest);
      return fromJob(j, j?.postedAt ?? null);
    }
    case 'merged':
    case 'failed': {
      const j = jobs.get(rest);
      return fromJob(j, j?.closedAt ?? null);
    }
    case 'pr': {
      const r = runs.get(rest);
      return { kind, tier: r ? (jobs.get(r.jobId)?.tier ?? null) : null, at: r?.startedAt ?? null, repo: r?.repo ?? null };
    }
    case 'revert':
    case 'note': {
      const e = entries.get(Number(rest));
      if (!e) return { kind, tier: null, at: null, repo: null };
      const d = e.data as Data;
      const j = jobs.get(str(d.jobId) ?? '');
      return { kind, tier: j?.tier ?? null, at: timeOf(e), repo: str(d.repo) ?? j?.repo ?? null };
    }
    case 'halt':
    case 'audit-due':
      return { kind, tier: null, at: null, repo: rest || null };
    default:
      return { kind, tier: null, at: null, repo: null };
  }
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Each day's first `brief.opened`, oldest first. */
function briefDays(): Array<{ day: string; at: string; items: string[] }> {
  const seen = new Set<string>();
  const out: Array<{ day: string; at: string; items: string[] }> = [];
  for (const e of query({ kind: 'brief.opened' })) {
    const d = e.data as Data;
    const day = str(d.day);
    if (!day || seen.has(day)) continue;
    seen.add(day);
    out.push({ day, at: timeOf(e), items: Array.isArray(d.items) ? d.items.filter((i): i is string => typeof i === 'string') : [] });
  }
  return out;
}

function finishedDays(now: number) {
  const today = localDay(now);
  return briefDays().filter((b) => b.day < today && ms(b.at) <= now);
}

/** The work kind a proposal job is decided as (ruling 14's `workKind`). */
function proposalKind(j: Job | undefined): WorkKind | null {
  if (!j) return null;
  return j.source === 'harness' ? 'propose:harness' : 'propose:readme-gap';
}

/**
 * The repo's share of his accepts in the brief on days before `day`, as a
 * triage row reads it; null when he has accepted nothing yet or the repo is
 * unknown.
 */
export function repoAcceptShare(repo: string | null, day: string): number | null {
  if (!repo) return null;
  const jobs = jobsById();
  const runs = new Map(listRuns().map((r) => [r.id, r]));
  const entries = new Map(query({ kind: ['merge.reverted', 'run.note'] }).map((e) => [e.id, e]));
  const past: Array<string | null> = [];
  for (const e of query({ kind: 'brief.action' })) {
    const a = e.data as Data;
    const d = str(a.day);
    const itemId = str(a.itemId);
    if (!d || !itemId || a.action !== 'accept' || d >= day) continue;
    past.push(itemFacts(itemId, jobs, runs, entries).repo);
  }
  return past.length ? past.filter((r) => r === repo).length / past.length : null;
}

function triageRows(now: number, teach: DistilPredict | null): Row[] {
  const days = finishedDays(now);
  if (days.length === 0) return [];
  const jobs = jobsById();
  const runs = new Map(listRuns().map((r) => [r.id, r]));
  const entries = new Map(query({ kind: ['merge.reverted', 'run.note'] }).map((e) => [e.id, e]));
  const actions = query({ kind: 'brief.action' }).map((e) => e.data as Data);
  const facts = (id: string) => itemFacts(id, jobs, runs, entries);
  // His actions by day and item, and his accepts by day, each read once.
  const actedOn = new Set<string>();
  const acceptsByDay = new Map<string, string[]>();
  for (const a of actions) {
    const day = str(a.day);
    const itemId = str(a.itemId);
    if (!day || !itemId) continue;
    if (a.action !== 'dismiss') actedOn.add(`${day}\n${itemId}`);
    if (a.action === 'accept') {
      const list = acceptsByDay.get(day) ?? [];
      list.push(itemId);
      acceptsByDay.set(day, list);
    }
  }
  const acceptDays = [...acceptsByDay.keys()].sort();
  const pastRepos: Array<string | null> = [];
  let next = 0;
  const rows: Row[] = [];
  const pending: Pending[] = [];
  for (const b of days) {
    const opened = ms(b.at);
    const open = new Date(opened);
    // Accepts on days before this one, accumulated as the days pass.
    for (; next < acceptDays.length && acceptDays[next] < b.day; next++) {
      for (const itemId of acceptsByDay.get(acceptDays[next]) ?? []) pastRepos.push(facts(itemId).repo);
    }
    b.items.forEach((itemId, position) => {
      const f = facts(itemId);
      const acted = actedOn.has(`${b.day}\n${itemId}`);
      const at = ms(f.at);
      const raw: RawRow = {
        kind: f.kind,
        tier: f.tier,
        hours_since_at: Number.isFinite(at) ? (opened - at) / 3_600_000 : null,
        weekday: WEEKDAYS[open.getDay()],
        first_open_hour: open.getHours() + open.getMinutes() / 60,
        position,
        repo_accept_share: f.repo && pastRepos.length > 0 ? pastRepos.filter((r) => r === f.repo).length / pastRepos.length : null,
      };
      const row = real(`${b.day}:${itemId}`, b.at, encode('triage', raw), acted ? 1 : 0);
      rows.push(row);
      if (teach && f.kind === 'proposal') {
        const j = jobs.get(itemId.slice(itemId.indexOf(':') + 1)) ?? null;
        pending.push({ row, kind: proposalKind(j ?? undefined), job: j, run: null, inspection: null });
      }
    });
  }
  return byAt([...rows, ...distil(rows.length, pending, teach)]);
}

// ---------------------------------------------------------------- taste

/** Each run's latest inspection, from `inspection.done`. */
function latestInspections(): Map<string, Inspection> {
  const out = new Map<string, Inspection>();
  for (const e of query({ kind: 'inspection.done' })) {
    const i = (e.data as Data).inspection as Inspection | undefined;
    if (i && typeof i.runId === 'string') out.set(i.runId, i);
  }
  return out;
}

function uiInspections(): Inspection[] {
  return [...latestInspections().values()].filter((i) => i.design);
}

/** 1 when he merged the PR, 0 when he closed it, null when it is not his PR-mode decision (yet). */
function prDecision(run: Run | undefined, now: number): 0 | 1 | null {
  if (!run || run.prNumber === null || !run.endedAt || ms(run.endedAt) > now) return null;
  if (run.outcome === 'merged') return 1;
  if (run.outcome === 'closed' && run.endedReason === PR_CLOSED_REASON) return 0;
  return null;
}

/** Taste's raw row for an inspection with the design judged; null without one. */
export function tasteRaw(i: Inspection): RawRow | null {
  if (!i.design) return null;
  const { before, after } = i.design;
  return { after, before, difference: before === null ? null : after - before, diff_only: i.design.diffOnly, shots: i.design.shots.length, pair: 0 };
}

function tasteRows(now: number, deps: DatasetDeps, teach: DistilPredict | null): Row[] {
  const runs = new Map(listRuns().map((r) => [r.id, r]));
  const acted = actedJobs();
  const rows: Row[] = [];
  const jobs = jobsById();
  const pending: Pending[] = [];
  for (const i of uiInspections()) {
    const y = acted.has(i.jobId) ? null : prDecision(runs.get(i.runId), now);
    if (y === null || !i.design) continue;
    const row = real(i.id, i.at, encode('taste', tasteRaw(i)!), y);
    rows.push(row);
    if (teach) pending.push({ row, kind: 'merge:ui', job: jobs.get(i.jobId) ?? null, run: runs.get(i.runId) ?? null, inspection: i });
  }
  for (const p of (deps.understudyPairs ?? understudyPairs)()) {
    if (!p.scores || (p.pick !== 'a' && p.pick !== 'b') || ms(p.at) > now) continue;
    const raw: RawRow = { after: p.scores.a, before: p.scores.b, difference: p.scores.a - p.scores.b, diff_only: 0, shots: 1, pair: 1 };
    rows.push(real(`pair:${p.id}`, p.at, encode('taste', raw), p.pick === 'a' ? 1 : 0));
  }
  return byAt([...rows, ...distil(rows.length, pending, teach)]);
}

// ---------------------------------------------------------------- master

interface Resolved {
  key: string;
  kind: WorkKind;
  repo: string;
  approved: boolean;
  predicted: boolean;
  inputs: Data;
  at: string;
}

/** The latest resolution of each decision key, in the order they were last resolved. */
function resolvedDecisions(now: number): Resolved[] {
  const latest = new Map<string, Resolved>();
  for (const e of query({ kind: 'decision.resolved' })) {
    const d = e.data as Data;
    const key = str(d.key);
    const at = timeOf(e);
    if (!key || typeof d.approved !== 'boolean' || ms(at) > now) continue;
    latest.delete(key);
    latest.set(key, {
      key,
      kind: d.kind as WorkKind,
      repo: str(d.repo) ?? '',
      approved: d.approved,
      predicted: typeof d.predictionId === 'number',
      inputs: d.inputs && typeof d.inputs === 'object' ? (d.inputs as Data) : {},
      at,
    });
  }
  return [...latest.values()];
}

/** His approval share on `repo` over its last 20 decisions resolved by `now` (latest resolution per key), or null with none. */
export function repoApprovalShare(repo: string, now: number): number | null {
  const last = resolvedDecisions(now).filter((x) => x.repo === repo).slice(-20);
  return last.length ? last.filter((x) => x.approved).length / last.length : null;
}

function masterRows(now: number): Row[] {
  const all = resolvedDecisions(now);
  const rows: Row[] = [];
  all.forEach((r, i) => {
    const before = all.slice(0, i).filter((x) => x.repo === r.repo).slice(-20);
    const input = (k: string) => (typeof r.inputs[k] === 'number' ? (r.inputs[k] as number) : null);
    const raw: RawRow = {
      appraiser: input('appraiser'),
      router: input('router'),
      durability: input('durability'),
      triage: input('triage'),
      taste: input('taste'),
      kind: r.kind,
      repo_approval_share: before.length ? before.filter((x) => x.approved).length / before.length : null,
    };
    rows.push(real(r.key, r.at, encode('master', raw), r.approved ? 1 : 0));
  });
  return byAt(rows);
}

// ---------------------------------------------------------------- the API

/**
 * Built rows by home, net, `now`, newest ledger id and newest credits id
 * (and, for taste, Understudy's answered pairs as read now, which change
 * outside the ledger; for the nets that distil, the school's switch and the
 * teacher, since a promotion is a ledger row but the switch is a setting);
 * only calls with no injected deps are kept.
 */
const memo = new Map<string, Row[]>();
const MEMO_MAX = 64;

function memoKey(net: NetName, now: number, extra = ''): string {
  const db = openDb();
  const ledger = (db.prepare('SELECT MAX(id) AS id FROM ledger').get() as { id: number | null }).id ?? 0;
  const credits = (db.prepare('SELECT MAX(id) AS id FROM credits').get() as { id: number | null }).id ?? 0;
  return `${paths().db}\n${net}\n${now}\n${ledger}\n${credits}\n${extra}`;
}

/**
 * The net's labelled rows as of `now`, oldest first (ruling 8). Built once
 * per state of the ledger and the credits, so labelCounts and thinCause
 * reuse them; a call with injected deps is always built afresh.
 */
export function rowsFor(net: NetName, now: number, deps: DatasetDeps = {}): Row[] {
  if (Object.keys(deps).length > 0) return buildRows(net, now, deps);
  // Understudy is read once per call: its pairs key the memo and build the rows.
  const pairs = net === 'taste' ? understudyPairs() : [];
  const distils = DISTILS.has(net) ? `${teacherGen}\n${getSettings().school.enabled}\n` : '';
  const key = memoKey(net, now, distils + (net === 'taste' ? JSON.stringify(pairs) : ''));
  const hit = memo.get(key);
  if (hit) return hit.map((r) => ({ ...r, x: [...r.x] }));
  const rows = buildRows(net, now, net === 'taste' ? { understudyPairs: () => pairs } : deps);
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(key, rows);
  return rows.map((r) => ({ ...r, x: [...r.x] }));
}

/** The only nets whose targets mean what the master's do (ruling 13). */
const DISTILS: ReadonlySet<NetName> = new Set(['triage', 'taste']);

function buildRows(net: NetName, now: number, deps: DatasetDeps): Row[] {
  const teach = DISTILS.has(net) ? (deps.predict ?? teacher) : null;
  switch (net) {
    case 'appraiser-pass':
    case 'appraiser-cost':
    case 'router': {
      const rows = appraisals(now).map((a) => {
        const x = encode(net, a.raw);
        const y = net === 'appraiser-cost' ? Math.log1p(runCredits(a.run.id)) : a.pass;
        return real(a.bid.id, a.awardAt, x, y);
      });
      return byAt(rows);
    }
    case 'durability':
      return durabilityRows(now);
    case 'triage':
      return triageRows(now, teach);
    case 'taste':
      return tasteRows(now, deps, teach);
    case 'master':
      return masterRows(now);
  }
}

const realCount = (rows: readonly Row[]): number => rows.filter((r) => r.source === 'real').length;

/** Every net's label count as of `now`: his own rows alone, never a distilled one. */
export function labelCounts(now: number, deps: DatasetDeps = {}): Record<NetName, number> {
  const pass = realCount(rowsFor('appraiser-pass', now, deps));
  const out = { 'appraiser-pass': pass, 'appraiser-cost': pass, router: pass } as Record<NetName, number>;
  for (const net of NETS) if (out[net] === undefined) out[net] = realCount(rowsFor(net, now, deps));
  return out;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Why the net has too few labels, in his words, from live counts (ruling 29). */
export function thinCause(net: NetName, now: number, deps: DatasetDeps = {}): string {
  const n = realCount(rowsFor(net, now, deps));
  switch (net) {
    case 'appraiser-pass':
    case 'appraiser-cost':
    case 'router': {
      const marketOn = listRepos().some((r) => r.connected && r.market);
      if (n === 0 && !marketOn) return 'No bid has been run: the market is off on every repo';
      return `${n} of ${NEEDS} awarded runs ended`;
    }
    case 'durability':
      return n === 0 ? `No city merge has had ${SURVIVE_DAYS} days yet` : `${n} of ${NEEDS} city merges have had ${SURVIVE_DAYS} days or a revert`;
    case 'triage':
      return `${plural(finishedDays(now).length, 'finished brief day')} so far`;
    case 'taste': {
      const u = (deps.understudyCounts ?? understudyCounts)();
      const understudy = !u
        ? ''
        : u.unreadable
          ? `; Understudy could not be read: ${u.unreadable}`
          : `; Understudy has ${plural(u.statements, 'statement')} and ${plural(u.answered, 'answered pair')}`;
      const inspected = uiInspections().length;
      if (inspected === 0) return `No UI change has been inspected yet${understudy}`;
      return `${n} of ${NEEDS} labels: ${plural(inspected, 'UI change')} inspected${understudy}`;
    }
    case 'master': {
      if (!resolvedDecisions(now).some((r) => r.predicted)) return 'None of your decisions has had a prediction yet';
      return `${n} of ${NEEDS} decisions resolved`;
    }
  }
}
