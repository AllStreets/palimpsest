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
 *   Understudy pair (injected until Task 10 lands).
 * - Master: one row per resolved decision, the latest resolution of its key.
 *
 * Ledger kinds later tasks add (`merge.followup`, `decision.resolved`) are
 * read by name, so they are simply empty until those tasks record them.
 * Every row is `source: 'real'` at weight 1; distilled rows are Task 13's.
 */
import { localDay } from '../../shared/day.js';
import { encode, LANGUAGE_VALUES, type RawRow } from '../../shared/net-features.js';
import { NET_MIN, SURVIVE_DAYS } from '../../shared/school-rules.js';
import type { Bid, Inspection, Job, NetName, Run, WorkKind } from '../../shared/types.js';
import { openDb } from '../db.js';
import { paths } from '../home.js';
import { query, type LedgerEntry } from '../ledger.js';
import { creditEntries } from '../market/budget.js';
import { agent } from '../market/firms.js';
import { listJobs } from '../market/jobs.js';
import { reputationLog, resolvedBids } from '../market/reputation.js';
import { listRuns } from '../market/runs.js';
import { getRepo, listRepos } from '../repos.js';

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
}

/** What later tasks provide, injected; each is empty by default. */
export interface DatasetDeps {
  understudyPairs?: () => UnderstudyPair[];
  understudyCounts?: () => UnderstudyCounts | null;
}

const NETS: readonly NetName[] = ['appraiser-pass', 'appraiser-cost', 'router', 'durability', 'triage', 'taste', 'master'];
const DAY_MS = 24 * 60 * 60 * 1000;
/** What a PR closed without a merge ends its run with (ship.ts `closed()`; Task 9 exports it as `PR_CLOSED_REASON`). */
const PR_CLOSED = 'The PR was closed without a merge.';
/** Labels a net needs before it reports anything (ruling 11). */
const NEEDS = NET_MIN.train + NET_MIN.heldOut;

type Data = Record<string, unknown>;

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
    const c = repo?.checks ?? null;
    const rep = standing.get(award.id) ?? { passRate: null, brier: null };
    out.push({
      bid,
      run,
      awardAt: timeOf(award),
      pass,
      raw: {
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
        price_over_value: job.value > 0 ? bid.price / job.value : null,
        confidence: bid.confidence,
        plan_words: words(bid.plan),
        workflow: a?.workflow.shape ?? null,
        model_family: familyOf(run.model),
        era: a?.capability ?? null,
        firm_pass_rate: rep.passRate,
        firm_brier: rep.brier,
      },
    });
  }
  return out;
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
    const diff = diffs.get(run.id);
    const files = Array.isArray(diff?.files) ? diff.files.length : run.progress.filesChanged;
    const lines = typeof diff?.lines === 'number' ? diff.lines : null;
    const insp = inspections.get(run.id) ?? null;
    const checks = insp?.checks ?? [];
    const review = checks.find((c) => c.name === 'review');
    const raw: RawRow = {
      diff_files: files,
      diff_lines: lines,
      tier: jobs.get(run.jobId)?.tier ?? null,
      model_family: familyOf(run.model),
      checks_passed: checks.filter((c) => c.status === 'pass').length,
      preexisting: checks.filter((c) => c.status === 'preexisting').length,
      design_checked: Boolean(insp?.design),
      review_concerns: review?.concerns?.length ?? 0,
      his_changes: Boolean(run.hisChanges),
    };
    rows.push(real(run.id, iso(t0), encode('durability', raw), broke ? 0 : 1));
  }
  return byAt(rows);
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

function triageRows(now: number): Row[] {
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
      rows.push(real(`${b.day}:${itemId}`, b.at, encode('triage', raw), acted ? 1 : 0));
    });
  }
  return byAt(rows);
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
  if (run.outcome === 'closed' && run.endedReason === PR_CLOSED) return 0;
  return null;
}

function tasteRows(now: number, deps: DatasetDeps): Row[] {
  const runs = new Map(listRuns().map((r) => [r.id, r]));
  const acted = actedJobs();
  const rows: Row[] = [];
  for (const i of uiInspections()) {
    const y = acted.has(i.jobId) ? null : prDecision(runs.get(i.runId), now);
    if (y === null || !i.design) continue;
    const { before, after } = i.design;
    const raw: RawRow = { after, before, difference: before === null ? null : after - before, diff_only: i.design.diffOnly, shots: i.design.shots.length, pair: 0 };
    rows.push(real(i.id, i.at, encode('taste', raw), y));
  }
  for (const p of (deps.understudyPairs ?? (() => []))()) {
    if (!p.scores || (p.pick !== 'a' && p.pick !== 'b') || ms(p.at) > now) continue;
    const raw: RawRow = { after: p.scores.a, before: p.scores.b, difference: p.scores.a - p.scores.b, diff_only: 0, shots: 1, pair: 1 };
    rows.push(real(`pair:${p.id}`, p.at, encode('taste', raw), p.pick === 'a' ? 1 : 0));
  }
  return byAt(rows);
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

/** Built rows by home, net, `now`, newest ledger id and newest credits id; only calls with no injected deps are kept. */
const memo = new Map<string, Row[]>();
const MEMO_MAX = 64;

function memoKey(net: NetName, now: number): string {
  const db = openDb();
  const ledger = (db.prepare('SELECT MAX(id) AS id FROM ledger').get() as { id: number | null }).id ?? 0;
  const credits = (db.prepare('SELECT MAX(id) AS id FROM credits').get() as { id: number | null }).id ?? 0;
  return `${paths().db}\n${net}\n${now}\n${ledger}\n${credits}`;
}

/**
 * The net's labelled rows as of `now`, oldest first (ruling 8). Built once
 * per state of the ledger and the credits, so labelCounts and thinCause
 * reuse them; a call with injected deps is always built afresh.
 */
export function rowsFor(net: NetName, now: number, deps: DatasetDeps = {}): Row[] {
  if (Object.keys(deps).length > 0) return buildRows(net, now, deps);
  const key = memoKey(net, now);
  const hit = memo.get(key);
  if (hit) return hit.map((r) => ({ ...r, x: [...r.x] }));
  const rows = buildRows(net, now, deps);
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(key, rows);
  return rows.map((r) => ({ ...r, x: [...r.x] }));
}

function buildRows(net: NetName, now: number, deps: DatasetDeps): Row[] {
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
      return triageRows(now);
    case 'taste':
      return tasteRows(now, deps);
    case 'master':
      return masterRows(now);
  }
}

/** Every net's label count as of `now`. */
export function labelCounts(now: number, deps: DatasetDeps = {}): Record<NetName, number> {
  const pass = rowsFor('appraiser-pass', now, deps).length;
  const out = { 'appraiser-pass': pass, 'appraiser-cost': pass, router: pass } as Record<NetName, number>;
  for (const net of NETS) if (out[net] === undefined) out[net] = rowsFor(net, now, deps).length;
  return out;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Why the net has too few labels, in his words, from live counts (ruling 29). */
export function thinCause(net: NetName, now: number, deps: DatasetDeps = {}): string {
  const n = rowsFor(net, now, deps).length;
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
      const u = (deps.understudyCounts ?? (() => null))();
      const understudy = u ? `; Understudy has ${plural(u.statements, 'statement')} and ${plural(u.answered, 'answered pair')}` : '';
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
