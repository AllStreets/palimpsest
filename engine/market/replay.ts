/**
 * Replay (spec 8, Task 18): the ledger alone rebuilds the market. Every kind
 * in LEDGER_KINDS has its case in `apply()`, and the switch is exhaustive,
 * so a kind added later without a case here is a type error.
 *
 * What each kind carries, as the writers record it:
 * - firms: `firm.seeded { firm }`, `firm.bankrupt { firmId, at }`; a firm's
 *   balance and `negativeSince` follow its `credits.moved` deltas (the
 *   treasury writes them on the firm after every movement, Task 17).
 * - agents: `agent.seeded | agent.hired | agent.revived { agent }`,
 *   `agent.retired { agentId, reason }`, `tower.sold { agentId, to }`
 *   (the stored agent keeps its plot's firm and gains `soldTo`).
 * - jobs: `job.posted | job.proposed { job }` and `job.changed { job }` hold
 *   the whole job; `run.started` ties the run to its job (attachRun) and an
 *   inconclusive `inspection.done` counts on the job (setInconclusive) until
 *   the next `job.changed` carries the count.
 * - bids: `bid.placed { bid }`, and every bid `job.awarded` considered.
 * - runs: `run.started { run }`, `run.stage`, `run.diff` (head and base sha),
 *   `inspection.done`, `pr.opened`, `run.ended { run }` (the whole run);
 *   a merge sha found later (`run.note` with `mergeSha`, `merge.reverted`)
 *   lands on the ended run.
 * - diffs: `run.diff { headSha, baseSha, files, lines, sha256, patchPath }`.
 * - floors: `floor.laid`, `floor.scarred { towerId, floor }`, `floor.lit`,
 *   `floor.removed`, `merge.reverted` (both floors of the job).
 * - halts and strikes: `repo.halted`, `repo.resumed`, and each conclusive
 *   `inspection.done` (a pass clears the strikes, a fail adds one).
 * - audits (Phase 3): `audit.started { audit }` and `audit.ended { audit }`
 *   hold the whole audit; `audit.stage { auditId, status, waitingReason? }`
 *   moves one in flight. Milestones: `milestone.reached { milestone }`,
 *   idempotent by id. `brief.opened` and `brief.action` carry no table.
 */
import type { Agent, Audit, AuditStatus, Bid, Firm, Floor, Inspection, Job, JobStatus, Milestone, Run, RunStage } from '../../shared/types.js';
import { isLedgerKind, type LedgerKind } from '../../shared/ledger-kinds.js';
import { START_BALANCE } from '../../shared/market-rules.js';
import { openDb } from '../db.js';
import { entries, type LedgerEntry } from '../ledger.js';

/** An agent as the table stores it: `soldTo` marks a dark tower a buyer re-clad. */
export type StoredAgent = Agent & { soldTo?: string };

export interface ReplayedDiff {
  runId: string;
  jobId: string;
  headSha: string | null;
  baseSha: string | null;
  files: string[];
  lines: number;
  sha256: string;
  patchPath: string | null;
}

export interface RunNote {
  id: number;
  at: string;
  runId: string | null;
  jobId: string | null;
  repo: string | null;
  note: string;
  /** Bookkeeping (a merge sha found), not a note for his brief. */
  internal: boolean;
  data: Record<string, unknown>;
}

export interface MarketState {
  firms: Record<string, Firm>;
  agents: Record<string, StoredAgent>;
  jobs: Record<string, Job>;
  bids: Record<string, Bid>;
  runs: Record<string, Run>;
  diffs: Record<string, ReplayedDiff>;
  inspections: Record<string, Inspection>;
  /** Every firm's balance from its seeded balance and its `credits.moved` deltas. */
  balances: Record<string, number>;
  /** Earned floors by tower id, in the order they were laid. */
  floors: Record<string, Floor[]>;
  /** Each repo the market halted, and why; null once resumed. */
  halts: Record<string, { at: string; reason: string } | null>;
  /** Failed inspections in a row, per repo. */
  strikes: Record<string, number>;
  notes: RunNote[];
  /** Repos connected or disconnected, by name (Phase 1). */
  repos: Record<string, { connected: boolean; analyzed: boolean; error: string | null }>;
  reports: Record<string, { path: string | null; at: string }>;
  api: { keySet: boolean };
  engine: { stopped: boolean };
  /** Trip ends recorded (the trips themselves are city state, Part B). */
  tripsEnded: string[];
  /** Every README audit, from `audit.started` then `audit.ended` (Phase 3). */
  audits: Record<string, Audit>;
  /** Every milestone reached, by id (Phase 3). */
  milestones: Record<string, Milestone>;
  /** Entries whose kind is outside LEDGER_KINDS (never written by record(); kept for the check). */
  unknown: number[];
  lastId: number;
}

const MICRO = 1_000_000;
const toMicro = (n: number) => Math.round(n * MICRO);
const fromMicro = (n: number) => n / MICRO;
const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const clone = <T>(x: T): T => (x === undefined ? x : (JSON.parse(JSON.stringify(x)) as T));

/** A JSON object with its keys sorted, for comparing replayed state with the tables. */
export function canonical(x: unknown): string {
  return JSON.stringify(x, (_k, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
    }
    return v;
  });
}

export function emptyState(): MarketState {
  return {
    firms: {},
    agents: {},
    jobs: {},
    bids: {},
    runs: {},
    diffs: {},
    inspections: {},
    balances: {},
    floors: {},
    halts: {},
    strikes: {},
    notes: [],
    repos: {},
    reports: {},
    api: { keySet: false },
    engine: { stopped: false },
    tripsEnded: [],
    audits: {},
    milestones: {},
    unknown: [],
    lastId: 0,
  };
}

type Data = Record<string, unknown>;

function moveMoney(s: MarketState, d: Data): void {
  const firmId = str(d.firmId);
  const delta = typeof d.delta === 'number' ? d.delta : 0;
  if (!firmId) return;
  const micro = toMicro(s.balances[firmId] ?? START_BALANCE) + toMicro(delta);
  const bal = fromMicro(micro);
  s.balances[firmId] = bal;
  const f = s.firms[firmId];
  if (!f) return;
  // As the treasury writes the books: below zero since the first movement that took it there.
  f.balance = bal;
  f.negativeSince = bal < 0 ? (f.negativeSince ?? str(d.at)) : null;
}

function layFloor(s: MarketState, towerId: string, floor: Floor): void {
  const tower = (s.floors[towerId] ??= []);
  const laid: Floor = { ...clone(floor), founding: false };
  const at = tower.findIndex((f) => f.id === laid.id);
  if (at >= 0) tower[at] = laid;
  else tower.push(laid);
}

function findFloor(s: MarketState, towerId: string, id: string): Floor | undefined {
  return s.floors[towerId]?.find((f) => f.id === id);
}

function setRunStage(s: MarketState, runId: string | null, stage: RunStage): void {
  const r = runId ? s.runs[runId] : undefined;
  if (r) r.stage = stage;
}

/** Applies one entry to the state. Exhaustive over LedgerKind. */
export function apply(s: MarketState, e: LedgerEntry): MarketState {
  s.lastId = Math.max(s.lastId, e.id);
  if (!isLedgerKind(e.kind)) {
    s.unknown.push(e.id);
    return s;
  }
  const kind: LedgerKind = e.kind;
  const d = (e.data ?? {}) as Data;
  switch (kind) {
    // ------------------------------------------------------------ Phase 1
    case 'repo.connected': {
      const repo = str(d.repo);
      if (repo) s.repos[repo] = { ...(s.repos[repo] ?? { analyzed: false, error: null }), connected: true };
      return s;
    }
    case 'repo.disconnected': {
      const repo = str(d.repo);
      if (repo) s.repos[repo] = { ...(s.repos[repo] ?? { analyzed: false, error: null }), connected: false };
      return s;
    }
    case 'repo.analyzed': {
      const repo = str(d.repo);
      if (repo) s.repos[repo] = { ...(s.repos[repo] ?? { connected: true }), analyzed: true, error: null };
      return s;
    }
    case 'repo.error': {
      const repo = str(d.repo);
      if (repo) s.repos[repo] = { ...(s.repos[repo] ?? { connected: true, analyzed: false }), error: str(d.error) };
      return s;
    }
    case 'repo.patched':
    case 'usage.hook.installed':
      return s;
    case 'engine.stopped':
      s.engine.stopped = true;
      return s;
    case 'engine.resumed':
      s.engine.stopped = false;
      return s;

    // ------------------------------------------------------------ firms and agents
    case 'firm.seeded': {
      const f = d.firm as Firm | undefined;
      if (!f?.id) return s;
      s.firms[f.id] = clone(f);
      s.balances[f.id] = typeof f.balance === 'number' ? f.balance : START_BALANCE;
      return s;
    }
    case 'agent.seeded':
    case 'agent.hired':
    case 'agent.revived': {
      const a = d.agent as Agent | undefined;
      if (!a?.id) return s;
      const soldTo = s.agents[a.id]?.soldTo;
      s.agents[a.id] = { ...clone(a), ...(soldTo ? { soldTo } : {}) };
      return s;
    }
    case 'agent.retired': {
      const a = s.agents[str(d.agentId) ?? ''];
      if (a && !a.retired) Object.assign(a, { retired: true, retiredReason: str(d.reason) });
      return s;
    }
    case 'firm.bankrupt': {
      const f = s.firms[str(d.firmId) ?? ''];
      if (f && f.status !== 'bankrupt') Object.assign(f, { status: 'bankrupt', bankruptAt: str(d.at) });
      return s;
    }
    case 'tower.sold': {
      const a = s.agents[str(d.agentId) ?? ''];
      const to = str(d.to);
      if (a && to) a.soldTo = to;
      return s;
    }
    case 'credits.moved':
      moveMoney(s, d);
      return s;

    // ------------------------------------------------------------ jobs and bids
    case 'job.proposed':
    case 'job.posted': {
      const j = d.job as Job | undefined;
      if (j?.id) s.jobs[j.id] = clone(j);
      return s;
    }
    case 'job.changed': {
      const j = d.job as Job | undefined;
      const id = str(d.id) ?? j?.id ?? null;
      if (!id) return s;
      if (j) s.jobs[id] = clone(j);
      else if (s.jobs[id] && str(d.to)) s.jobs[id].status = d.to as JobStatus;
      return s;
    }
    case 'bid.placed': {
      const b = d.bid as Bid | undefined;
      if (b?.id) s.bids[b.id] = clone(b);
      return s;
    }
    case 'job.awarded': {
      // Every bid the award weighed, for a bid placed before bid.placed carried it whole.
      for (const b of [...((d.considered as Bid[] | undefined) ?? []), d.chosen as Bid | null | undefined]) {
        if (b?.id && !s.bids[b.id]) s.bids[b.id] = clone(b);
      }
      return s;
    }

    // ------------------------------------------------------------ runs
    case 'run.started': {
      const r = d.run as Run | undefined;
      if (!r?.id) return s;
      s.runs[r.id] = clone(r);
      const j = s.jobs[r.jobId];
      if (j) j.runId = r.id;
      return s;
    }
    case 'run.stage':
      setRunStage(s, str(d.runId), d.stage as RunStage);
      return s;
    case 'run.refused':
      return s;
    case 'run.diff': {
      const runId = str(d.runId);
      if (!runId) return s;
      s.diffs[runId] = {
        runId,
        jobId: str(d.jobId) ?? s.runs[runId]?.jobId ?? '',
        headSha: str(d.headSha),
        baseSha: str(d.baseSha),
        files: Array.isArray(d.files) ? (d.files as string[]).slice() : [],
        lines: typeof d.lines === 'number' ? d.lines : 0,
        sha256: str(d.sha256) ?? '',
        patchPath: str(d.patchPath),
      };
      const r = s.runs[runId];
      if (r) {
        if (str(d.headSha)) r.headSha = str(d.headSha);
        if (str(d.baseSha)) r.baseSha = str(d.baseSha);
      }
      return s;
    }
    case 'run.ended': {
      const r = d.run as Run | undefined;
      if (r?.id) s.runs[r.id] = clone(r);
      return s;
    }
    case 'run.note': {
      const note: RunNote = {
        id: e.id,
        at: str(d.at) ?? e.at,
        runId: str(d.runId),
        jobId: str(d.jobId),
        repo: str(d.repo),
        note: str(d.note) ?? '',
        internal: d.internal === true || /^merge [0-9a-f]{7,40} recorded for push mode$/.test(str(d.note) ?? ''),
        data: clone(d),
      };
      s.notes.push(note);
      // A merge sha the revert watch found for a run that already ended.
      const r = note.runId ? s.runs[note.runId] : undefined;
      if (r && r.outcome !== null && note.internal && str(d.mergeSha)) r.mergeSha = str(d.mergeSha);
      return s;
    }
    case 'check.done':
      return s;
    case 'inspection.done': {
      const i = d.inspection as Inspection | undefined;
      if (!i?.id) return s;
      s.inspections[i.id] = clone(i);
      const r = s.runs[i.runId];
      if (r && r.outcome === null) r.inspectionId = i.id;
      const inconclusive = !i.passed && !!i.inconclusive;
      if (inconclusive) {
        const j = s.jobs[i.jobId];
        if (j) j.inconclusive = (j.inconclusive ?? 0) + 1;
      } else if (i.repo) {
        s.strikes[i.repo] = i.passed ? 0 : (s.strikes[i.repo] ?? 0) + 1;
      }
      return s;
    }
    case 'pr.opened': {
      const r = s.runs[str(d.runId) ?? ''];
      if (r) {
        r.prNumber = typeof d.number === 'number' ? d.number : r.prNumber;
        r.prUrl = str(d.url) ?? r.prUrl;
      }
      return s;
    }
    case 'pushed':
    case 'merge.detected':
      // The run's end and the job's move carry what changed.
      return s;
    case 'merge.reverted': {
      const repo = str(d.repo);
      const floorId = str(d.floorId);
      const jobId = str(d.jobId);
      if (repo && floorId) {
        const f = findFloor(s, `${repo}#founding`, floorId);
        if (f?.earned) {
          f.earned.reverted = true;
          const agentId = f.earned.agentId;
          const mine = findFloor(s, `agent:${agentId}`, `agent:${agentId}#job-${jobId ?? f.earned.jobId}`);
          if (mine?.earned) mine.earned.reverted = true;
        }
      }
      const r = s.runs[str(d.runId) ?? ''];
      if (r && r.outcome !== null && str(d.mergeSha)) r.mergeSha = str(d.mergeSha);
      return s;
    }

    // ------------------------------------------------------------ floors
    case 'floor.laid':
    case 'floor.scarred': {
      const towerId = str(d.towerId);
      const floor = d.floor as Floor | undefined;
      if (towerId && floor?.id) layFloor(s, towerId, floor);
      return s;
    }
    case 'floor.lit': {
      const towerId = str(d.towerId);
      if (!towerId) return s;
      const floor = d.floor as Floor | undefined;
      if (floor?.id) {
        layFloor(s, towerId, floor);
        return s;
      }
      const f = findFloor(s, towerId, str(d.floorId) ?? '');
      if (f?.earned) f.earned.state = 'lit';
      return s;
    }
    case 'floor.removed': {
      const towerId = str(d.towerId);
      const id = str(d.floorId);
      if (towerId && id && s.floors[towerId]) s.floors[towerId] = s.floors[towerId].filter((f) => f.id !== id);
      return s;
    }

    // ------------------------------------------------------------ halts
    case 'repo.halted': {
      const repo = str(d.repo);
      if (repo) s.halts[repo] = { at: str(d.at) ?? e.at, reason: str(d.reason) ?? '' };
      return s;
    }
    case 'repo.resumed': {
      const repo = str(d.repo);
      if (repo) {
        s.halts[repo] = null;
        s.strikes[repo] = 0;
      }
      return s;
    }

    // ------------------------------------------------------------ the rest
    case 'trip.started':
      return s;
    case 'trip.ended': {
      const id = str(d.tripId);
      if (id) s.tripsEnded.push(id);
      return s;
    }
    case 'report.written': {
      const day = str(d.day);
      if (day) s.reports[day] = { path: str(d.path), at: e.at };
      return s;
    }
    case 'api.key.set':
      s.api.keySet = true;
      return s;
    case 'api.key.removed':
      s.api.keySet = false;
      return s;

    // ------------------------------------------------------------ Phase 3: audits, the brief and milestones
    case 'audit.started':
    case 'audit.ended': {
      const a = d.audit as Audit | undefined;
      if (a?.id) s.audits[a.id] = clone(a);
      return s;
    }
    case 'audit.stage': {
      // A stage moves one audit in flight; one naming a status outside AuditStatus is ignored whole.
      // A waiting audit dropped from the queue (its repo was disconnected) leaves the state as it left the table.
      if (d.dropped === true) {
        delete s.audits[str(d.auditId) ?? ''];
        return s;
      }
      const a = s.audits[str(d.auditId) ?? ''];
      if (a && AUDIT_STATUSES.has(d.status as AuditStatus)) {
        a.status = d.status as AuditStatus;
        if ('waitingReason' in d) a.waitingReason = str(d.waitingReason);
        if (str(d.model)) a.model = d.model as Audit['model'];
        if (str(d.baseSha)) a.baseSha = d.baseSha as string;
        if (typeof d.unattended === 'boolean') a.unattended = d.unattended;
        if (str(d.startedAt)) a.startedAt = d.startedAt as string;
      }
      return s;
    }
    case 'brief.opened':
    case 'brief.action':
      // His mornings are recorded for Triage; no table holds them.
      return s;
    case 'milestone.reached': {
      const m = d.milestone as Milestone | undefined;
      if (m?.id) s.milestones[m.id] = clone(m);
      return s;
    }
    default: {
      const missing: never = kind;
      throw new Error(`replay has no case for ${String(missing)}`);
    }
  }
}

/** The market rebuilt from `log` (the whole ledger, oldest first). */
export function replay(log: LedgerEntry[]): MarketState {
  const s = emptyState();
  for (const e of log) apply(s, e);
  return s;
}

// ---------------------------------------------------------------- the check

function rows(sql: string): Array<{ id: string; json: string }> {
  return openDb().prepare(sql).all() as Array<{ id: string; json: string }>;
}

function compare(label: string, stored: Record<string, unknown>, replayed: Record<string, unknown>, diffs: string[], pick?: (id: string, x: unknown) => unknown): void {
  for (const id of new Set([...Object.keys(stored), ...Object.keys(replayed)])) {
    const a = stored[id];
    const b = replayed[id];
    if (a === undefined) {
      diffs.push(`${label} ${id}: in the ledger but not in the tables`);
      continue;
    }
    if (b === undefined) {
      diffs.push(`${label} ${id}: in the tables but not in the ledger`);
      continue;
    }
    const x = canonical(pick ? pick(id, a) : a);
    const y = canonical(pick ? pick(id, b) : b);
    if (x !== y) diffs.push(`${label} ${id}: the tables hold ${x.slice(0, 400)} but the ledger says ${y.slice(0, 400)}`);
  }
}

/** The fields of a run still in flight that the ledger carries (the rest, such as progress, arrive whole with `run.ended`). */
const LIVE_RUN_FIELDS: Array<keyof Run> = ['id', 'jobId', 'bidId', 'agentId', 'firmId', 'repo', 'model', 'branch', 'stage', 'outcome', 'headSha', 'prNumber', 'prUrl', 'inspectionId', 'startedAt', 'unattended'];
/** The fields of an audit still in flight that the ledger carries (its findings and counts arrive whole with `audit.ended`). */
const LIVE_AUDIT_FIELDS: Array<keyof Audit> = ['id', 'repo', 'model', 'trigger', 'baseSha', 'status', 'waitingReason', 'startedAt', 'unattended'];
const AUDIT_STATUSES: ReadonlySet<AuditStatus> = new Set<AuditStatus>(['waiting', 'preparing', 'installing', 'reading', 'done', 'failed', 'capped', 'killed', 'crashed']);
const ENDED_AUDIT: ReadonlySet<AuditStatus> = new Set<AuditStatus>(['done', 'failed', 'capped', 'killed', 'crashed']);

/**
 * Replays the whole ledger and compares it with the tables: firms (with
 * their books), agents, jobs, bids, runs, inspections, earned floors, each
 * repo's halt and strikes, and (Phase 3) the audits and the milestones.
 * `diffs` names every disagreement.
 */
export function verifyReplay(): { ok: boolean; diffs: string[] } {
  const s = replay(entries());
  const diffs: string[] = [];
  const table = (sql: string) => Object.fromEntries(rows(sql).map((r) => [r.id, JSON.parse(r.json) as unknown]));

  for (const id of s.unknown) diffs.push(`ledger entry ${id}: a kind outside LEDGER_KINDS`);
  compare('firm', table('SELECT id, json FROM firms'), s.firms, diffs);
  compare('agent', table('SELECT id, json FROM agents'), s.agents, diffs);
  compare('job', table('SELECT id, json FROM jobs'), s.jobs, diffs);
  const storedBids = Object.fromEntries(
    rows('SELECT id, json FROM bids')
      .map((r) => JSON.parse(r.json) as { bid?: Bid })
      .filter((r) => r.bid)
      .map((r) => [r.bid!.id, r.bid as unknown]),
  );
  compare('bid', storedBids, s.bids, diffs);
  const storedRuns = table('SELECT id, json FROM runs') as Record<string, Run>;
  compare('run', storedRuns, s.runs, diffs, (_id, x) => {
    const r = x as Run;
    // A run still in flight is compared on what the ledger carries; an ended one whole.
    if (storedRuns[r.id]?.outcome === null || s.runs[r.id]?.outcome === null) return Object.fromEntries(LIVE_RUN_FIELDS.map((k) => [k, r[k] ?? null]));
    return r;
  });
  compare('inspection', table('SELECT id, json FROM inspections'), s.inspections, diffs);
  const storedAudits = table('SELECT id, json FROM audits') as Record<string, Audit>;
  compare('audit', storedAudits, s.audits, diffs, (_id, x) => {
    const a = x as Audit;
    // An audit still in flight is compared on what the ledger carries; an ended one whole.
    const live = (y: Audit | undefined) => y !== undefined && !ENDED_AUDIT.has(y.status);
    if (live(storedAudits[a.id]) || live(s.audits[a.id])) return Object.fromEntries(LIVE_AUDIT_FIELDS.map((k) => [k, a[k] ?? null]));
    return a;
  });
  compare('milestone', table('SELECT id, json FROM milestones'), s.milestones, diffs);

  const towers: Record<string, unknown> = {};
  for (const r of openDb().prepare('SELECT tower_id, json FROM earned_floors ORDER BY tower_id, seq').all() as Array<{ tower_id: string; json: string }>) {
    ((towers[r.tower_id] ??= []) as unknown[]).push(JSON.parse(r.json));
  }
  const replayedTowers = Object.fromEntries(Object.entries(s.floors).filter(([, fs]) => fs.length > 0));
  compare('tower', towers, replayedTowers, diffs);

  for (const r of openDb().prepare('SELECT full_name, json FROM repos').all() as Array<{ full_name: string; json: string }>) {
    const repo = JSON.parse(r.json) as { halted?: { at: string; reason: string } | null; strikes?: number };
    const halted = canonical(repo.halted ?? null);
    const replayed = canonical(s.halts[r.full_name] ?? null);
    if (halted !== replayed) diffs.push(`repo ${r.full_name}: halted ${halted} in the tables but ${replayed} in the ledger`);
    if ((repo.strikes ?? 0) !== (s.strikes[r.full_name] ?? 0)) diffs.push(`repo ${r.full_name}: ${repo.strikes ?? 0} strikes in the tables but ${s.strikes[r.full_name] ?? 0} in the ledger`);
  }
  return { ok: diffs.length === 0, diffs };
}
