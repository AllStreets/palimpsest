/**
 * The market over HTTP (Task 20): jobs, firms, agents, runs, inspections,
 * the treasury, reports, providers, quarters and the live view. The server
 * has already checked Host, Origin and the `x-palimpsest` header before a
 * request gets here. Nothing here sends a path of this Mac, a raw secret or
 * more of a log than the screen shows: every outgoing string goes through
 * redact(), a run's directory is never sent, and an inspection's logs and
 * shots are read only from inside the runs folder.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import { audit as storedAudit, listAudits } from '../audit/store.js';
import { killAudit, queueAudit } from '../audit/run.js';
import { proposeAgain } from '../audit/proposals.js';
import { actOn, briefData, openBrief } from '../brief.js';
import { LEGAL_MOVES, LIVE_JOB_STATUSES, MAX_ATTEMPTS, runsUnderWay } from '../../shared/market-rules.js';
import type {
  Agent,
  Audit,
  AuditView,
  BriefAction,
  AgentDetail,
  CheckView,
  CreditEntries,
  Firm,
  FirmDetail,
  FirmView,
  Inspection,
  InspectionView,
  Job,
  JobDetail,
  JobStatus,
  LedgerRow,
  LiveView,
  ReportView,
  Run,
  RunDetail,
  RunLogLine,
  RunView,
  SiteState,
  Tier,
  TreasuryView,
  Trip,
} from '../../shared/types.js';
import { openDb } from '../db.js';
import { HttpError, readObjectBody, sendJson, sendText } from '../http.js';
import { query } from '../ledger.js';
import { paths } from '../home.js';
import { getRepo, isValidFullName, BAD_NAME } from '../repos.js';
import { providerUsages } from '../providers-usage.js';
import { apiKeyStored, setApiKey, removeApiKey } from './anthropic-api.js';
import { bidList } from './bids.js';
import { MAX_RESUME_MS, treasury } from './budget.js';
import { agent, firm, listAgents, listFirms, quarters, toGenome } from './firms.js';
import { job, listJobs, postManualJob, redact, repost, setScope, setTier, transition, withdrawable } from './jobs.js';
import { listMilestones, weekTour } from './milestones.js';
import { latestReport } from './report.js';
import { firmBooks, firmDeals, firmRounds } from './firm-story.js';
import { reputation, reputationLine, reputationLog } from './reputation.js';
import { kill, killJob, listRuns, resumeJob, run, sites } from './runs.js';
import { balances, negativeSinceOf } from './treasury.js';
import { activeTrips } from './trips.js';
import { isStale, latestReading, storedCalibration } from '../usage.js';
import { getSettings, patchSettings } from '../settings.js';
import { CITY_KEY, creditEntries, periodBounds, spendBetween } from './spend.js';

/**
 * What a sample engine (Task 21) adds to the live view and Settings: the
 * sample economy's job sites and trips, and provider readers that never
 * reach a real service. A real engine sets none.
 */
export interface MarketExtras {
  sites?: () => SiteState[];
  providers?: Parameters<typeof providerUsages>[0];
}

let extras: MarketExtras = {};

export function setMarketExtras(x: MarketExtras): void {
  extras = x;
}

export interface MarketApiOptions {
  /** The keychain file the API key routes use; without it, his login keychain (never under tests). */
  keychain?: string;
}

const JOB_STATUSES = Object.keys(LEGAL_MOVES) as JobStatus[];
const TIERS: Tier[] = ['low', 'normal', 'high'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const BRIEF_ACTIONS: BriefAction[] = ['accept', 'tier', 'dismiss', 'why', 'diff', 'fly', 'retry', 'resume', 'open-pr', 'cap', 'audit', 'tour'];
/** The most of an audit's page the API carries. */
const AUDIT_PAGE_CAP = 512 * 1024;
/** The most of a check log the API carries. */
export const LOG_CAP = 64 * 1024;
const DIFF_CAP = 2 * 1024 * 1024;
const LOG_FILE_CAP = 16 * 1024 * 1024;
const LOG_PAGE = 2000;
const LEDGER_CAP = 500;

/** Keys whose values are places on this Mac. */
const PATH_KEYS = new Set(['dir', 'logPath', 'patchPath', 'runRoot', 'markdownPath']);
const HASH = /^[0-9a-f]{40,64}$/;

/** Text with tokens and paths taken out; a bare hash (a sha) stays, it is an identifier. */
function clean(text: string): string {
  return HASH.test(text) ? text : redact(text);
}

/**
 * A value as it may leave the engine: every string redacted, every key that
 * names a place on this Mac dropped. Used for ledger rows, log lines and the
 * event stream.
 */
export function scrub(value: unknown): unknown {
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!PATH_KEYS.has(k)) out[k] = scrub(v);
    return out;
  }
  return value;
}

function idOf(s: string, what: string): string {
  if (!ID.test(s)) throw new HttpError(400, { error: `That is not a ${what} id.` });
  return s;
}

function mustJob(id: string): Job {
  const j = job(idOf(id, 'job'));
  if (!j) throw new HttpError(404, { error: 'unknown job' });
  return j;
}

/** A refused move is a conflict with where the job is, not a server error. */
function moving<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error && /^illegal move|^job \S+ is |^scope refused: |^acceptance needs at least one line/.test(err.message)) throw new HttpError(409, { error: err.message });
    throw err;
  }
}

// ------------------------------------------------------------------ views

/**
 * A diff is the repo's own code, which the page shows as it is: it is not
 * run through redact() (that would cut long identifiers and hashes out of
 * code). Only this Mac's home and data folders are taken out of it.
 */
function homePathsOut(text: string): string {
  let s = text.split(homedir()).join('~');
  const data = paths().runs.slice(0, -'/runs'.length);
  if (data && data !== homedir()) s = s.split(data).join('[home]');
  return s;
}

function publicRun(r: Run): RunView {
  const { dir: _dir, ...rest } = r;
  return { ...rest, summary: r.summary ? redact(r.summary) : r.summary, endedReason: r.endedReason ? redact(r.endedReason) : r.endedReason };
}

/** The real path of `p` when it is a file inside the runs folder, else null. */
function insideRuns(p: string | null): string | null {
  if (!p) return null;
  try {
    const real = realpathSync(p);
    const root = realpathSync(paths().runs);
    return real.startsWith(root + sep) && statSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/** The last LOG_CAP bytes of a check's log, redacted; null when there is none or it lies outside the runs folder. */
function readLog(logPath: string | null): string | null {
  const real = insideRuns(logPath);
  if (!real) return null;
  const size = statSync(real).size;
  const len = Math.min(size, LOG_CAP);
  const buf = Buffer.alloc(len);
  const fd = openSync(real, 'r');
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  return redact(buf.toString('utf8'));
}

function shotUrl(inspectionId: string, route: string, which: 'before' | 'after'): string {
  return `/api/inspections/${encodeURIComponent(inspectionId)}/shot/${encodeURIComponent(route)}/${which}`;
}

export function inspectionView(i: Inspection, withLogs: boolean): InspectionView {
  const checks: CheckView[] = i.checks.map(({ logPath, ...c }) => ({ ...c, detail: redact(c.detail), log: withLogs ? readLog(logPath) : null }));
  const design = i.design
    ? {
        ...i.design,
        shots: i.design.shots.map((s) => ({
          route: s.route,
          before: insideRuns(s.before) ? shotUrl(i.id, s.route, 'before') : null,
          after: insideRuns(s.after) ? shotUrl(i.id, s.route, 'after') : null,
        })),
      }
    : null;
  return { ...i, checks, design, inconclusive: i.inconclusive ? redact(i.inconclusive) : i.inconclusive };
}

function inspectionById(id: string): Inspection | null {
  const row = openDb().prepare('SELECT json FROM inspections WHERE id = ?').get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as Inspection) : null;
}

function inspectionsOfRun(runId: string): Inspection[] {
  const rows = openDb().prepare('SELECT json FROM inspections WHERE run_id = ?').all(runId) as Array<{ json: string }>;
  return rows.map((r) => JSON.parse(r.json) as Inspection).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

function mustRun(id: string): Run {
  const r = run(idOf(id, 'run'));
  if (!r) throw new HttpError(404, { error: 'unknown run' });
  return r;
}

// ------------------------------------------------------------------ jobs

function jobDetail(j: Job): JobDetail {
  const { bids, satOut } = bidList(j.id);
  const [awarded] = query({ kind: 'job.awarded', jobId: j.id, last: true });
  const a = awarded?.data as { chosen?: unknown; why?: unknown; satOut?: unknown } | undefined;
  const runs = listRuns({ jobId: j.id });
  const ledger: LedgerRow[] = query({ jobId: j.id }).slice(-LEDGER_CAP).map((e) => ({ id: e.id, at: e.at, kind: e.kind, data: scrub(e.data) }));
  // A bid's plan is model output: redacted here, field by field, as well as by send()'s scrub of the whole answer.
  const plain = (b: JobDetail['bids'][number] | null): JobDetail['bids'][number] | null => (b ? { ...b, plan: redact(String(b.plan ?? '')) } : null);
  return {
    job: j,
    bids: bids.map((b) => plain(b)!),
    award: a
      ? {
          chosen: plain((a.chosen as JobDetail['bids'][number] | null) ?? null),
          why: typeof a.why === 'string' ? redact(a.why) : '',
          satOut: Array.isArray(a.satOut) ? (a.satOut as Array<{ agentId: string; reason: string }>).map((s) => ({ agentId: s.agentId, reason: redact(String(s.reason)) })) : [],
        }
      : null,
    satOut: satOut.map((s) => ({ agentId: s.agentId, firmId: s.firmId, reason: redact(String(s.reason)), at: s.at })),
    runs: runs.map(publicRun),
    inspections: runs.flatMap((r) => inspectionsOfRun(r.id)).map((i) => inspectionView(i, false)),
    ledger,
  };
}

function text(b: Record<string, unknown>, key: string, max: number, required: boolean): string | undefined {
  const v = b[key];
  if (v === undefined) {
    if (required) throw new HttpError(400, { error: `a job needs a ${key}` });
    return undefined;
  }
  if (typeof v !== 'string' || (required && !v.trim()) || v.length > max) throw new HttpError(400, { error: `${key} must be text of at most ${max} characters` });
  return v;
}

function list(b: Record<string, unknown>, key: string): string[] | undefined {
  const v = b[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== 'string' || !x.trim() || x.length > 300)) {
    throw new HttpError(400, { error: `${key} must be a list of up to 50 short texts` });
  }
  return v as string[];
}

function tierOf(v: unknown): Tier {
  if (typeof v !== 'string' || !TIERS.includes(v as Tier)) throw new HttpError(400, { error: `tier must be one of ${TIERS.join(', ')}` });
  return v as Tier;
}

async function postJob(req: IncomingMessage): Promise<Job> {
  const b = await readObjectBody(req);
  const repo = b.repo;
  if (typeof repo !== 'string' || !isValidFullName(repo)) throw new HttpError(400, { error: BAD_NAME });
  const title = text(b, 'title', 200, true) as string;
  const body = text(b, 'body', 20_000, false);
  const tier = b.tier === undefined ? undefined : tierOf(b.tier);
  const scope = list(b, 'scope');
  const acceptance = list(b, 'acceptance');
  if (!getRepo(repo)?.connected) throw new HttpError(404, { error: `${repo} is not connected` });
  return postManualJob({ repo, title, body, tier, scope, acceptance });
}

async function withdraw(j: Job): Promise<Job> {
  if (!withdrawable(j)) {
    const why = j.status === 'waiting' || (j.status === 'halted' && j.haltedFrom === 'waiting') ? 'its pull request is open: close or merge it on GitHub' : `a ${j.status} job cannot be withdrawn`;
    throw new HttpError(409, { error: why });
  }
  if (j.status === 'running' || j.status === 'inspecting' || (j.status === 'awarded' && j.runId)) await killJob(j.id, 'He withdrew the job.');
  const now = job(j.id);
  if (!now || !withdrawable(now)) throw new HttpError(409, { error: 'the job moved on; look again' });
  return moving(() => transition(now, 'withdrawn', {}, { by: 'him' }));
}

// ------------------------------------------------------------------ audits

function publicAudit(a: Audit): Omit<Audit, 'markdownPath'> {
  const { markdownPath: _p, ...rest } = a;
  return rest;
}

/** An audit's page, read only from inside the reports folder; null when it has none. */
function auditPage(path: string | null): string | null {
  if (!path) return null;
  try {
    const real = realpathSync(path);
    const root = realpathSync(join(paths().reports, 'audits'));
    if (!real.startsWith(root + sep) || !statSync(real).isFile()) return null;
    return readFileSync(real, 'utf8').slice(0, AUDIT_PAGE_CAP);
  } catch {
    return null;
  }
}

function auditView(a: Audit): AuditView {
  return { ...publicAudit(a), markdown: auditPage(a.markdownPath), proposals: listJobs().filter((j) => j.proposal?.auditId === a.id) };
}

function mustAudit(id: string): Audit {
  const a = storedAudit(idOf(id, 'audit'));
  if (!a) throw new HttpError(404, { error: 'unknown audit' });
  return a;
}

function startAudit(ownerRaw: string, nameRaw: string): Omit<Audit, 'markdownPath'> {
  let full: string;
  try {
    full = `${decodeURIComponent(ownerRaw)}/${decodeURIComponent(nameRaw)}`;
  } catch {
    throw new HttpError(400, { error: BAD_NAME });
  }
  if (!isValidFullName(full)) throw new HttpError(400, { error: BAD_NAME });
  const repo = getRepo(full);
  if (!repo?.connected) throw new HttpError(404, { error: `${full} is not connected` });
  try {
    return publicAudit(queueAudit(repo, 'demand'));
  } catch (err) {
    throw new HttpError(409, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ------------------------------------------------------------------ the brief

/** What actOn and the moves behind it say when they refuse: the item or action is not offered, a job is not where the action needs it, a repo is gone or already audited. */
const REFUSED = /^no brief item |^\S+ does not offer |^tier needs |^cap needs |^no repo |^no job |^illegal move|^job \S+ is |^job \S+ cannot |^scope refused: |already has an audit|is halted|not halted/;

async function briefAction(req: IncomingMessage, itemRaw: string, actionRaw: string): Promise<{ item: unknown; result: unknown }> {
  let itemId: string;
  try {
    itemId = decodeURIComponent(itemRaw);
  } catch {
    throw new HttpError(400, { error: 'not a brief item' });
  }
  if (!itemId || itemId.length > 200) throw new HttpError(400, { error: 'not a brief item' });
  if (!BRIEF_ACTIONS.includes(actionRaw as BriefAction)) throw new HttpError(400, { error: `action must be one of ${BRIEF_ACTIONS.join(', ')}` });
  const b = await readObjectBody(req);
  const body: { tier?: Tier; pct?: number } = {};
  if (b.tier !== undefined) body.tier = tierOf(b.tier);
  if (b.pct !== undefined) {
    if (typeof b.pct !== 'number' || !Number.isFinite(b.pct)) throw new HttpError(400, { error: 'pct must be a number' });
    body.pct = b.pct;
  }
  // The action goes through actOn, which refuses with a reason and records what he did (a retry included).
  try {
    return actOn(itemId, actionRaw as BriefAction, body);
  } catch (err) {
    if (err instanceof Error && REFUSED.test(err.message)) throw new HttpError(409, { error: err.message });
    throw err;
  }
}

// ------------------------------------------------------------------ firms, agents

/**
 * A firm as every screen shows it: its balance from the treasury's rows
 * (charges not yet settled included), and whether and since when it is below
 * zero by that same balance. The stored balance and negativeSince are what
 * the treasury last wrote at a settle; the report and replay keep reading those.
 */
function liveFirm<T extends Firm>(f: T, b: Record<string, number> = balances()): T {
  const balance = b[f.id] ?? f.balance;
  // Below zero with nothing stored yet (a charge not yet settled took it there): since that charge, the same on every read.
  const negativeSince = balance < 0 ? (f.negativeSince ?? negativeSinceOf(f.id) ?? f.createdAt) : f.status === 'bankrupt' ? f.negativeSince : null;
  return { ...f, balance, negativeSince };
}

function firmView(f: ReturnType<typeof listFirms>[number], log = reputationLog(), b: Record<string, number> = balances()): FirmView {
  return { ...liveFirm(f, b), reputation: reputation(f.id, log), agents: listAgents(f.id) };
}


function agentDetail(a: Agent): AgentDetail {
  const parents = a.lineage.parents.map((p) => agent(p)).filter((x): x is Agent => x !== null);
  const children = listAgents().filter((x) => x.lineage.parents.includes(a.id));
  const tower = quarters().flatMap((q) => q.towers).find((t) => t.agentId === a.id) ?? null;
  return {
    agent: a,
    firm: ((f) => (f ? liveFirm(f) : null))(firm(a.firmId)),
    tower,
    runs: listRuns().filter((r) => r.agentId === a.id).map(publicRun),
    genome: toGenome(a),
    lineage: { agent: a.lineage, parents, children },
    reputation: firm(a.firmId) ? reputation(a.firmId) : null,
    towerFirmId: tower?.firmId ?? null,
  };
}

// ------------------------------------------------------------------ runs

/** A run's log lines after the first `since` of them, redacted. */
function logLines(runId: string, sinceRaw: string | null): RunLogLine[] {
  let since = 0;
  if (sinceRaw !== null) {
    if (!/^\d{1,9}$/.test(sinceRaw)) throw new HttpError(400, { error: 'since is a line count' });
    since = Number(sinceRaw);
  }
  const file = join(paths().runs, runId, 'log.jsonl');
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  let raw: string[];
  let from = since;
  if (size > LOG_FILE_CAP) {
    // Too big to page from the start: the newest page of lines, from the tail of the file.
    const buf = Buffer.alloc(LOG_FILE_CAP);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buf, 0, LOG_FILE_CAP, size - LOG_FILE_CAP);
    } finally {
      closeSync(fd);
    }
    raw = buf.toString('utf8').split('\n').slice(1).filter((l) => l.trim() !== '');
    from = Math.max(0, raw.length - LOG_PAGE);
  } else {
    raw = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
  }
  return raw.slice(from, from + LOG_PAGE).map((l): RunLogLine => {
    try {
      const o = JSON.parse(l) as RunLogLine;
      return { at: String(o.at), kind: o.kind, text: redact(String(o.text ?? '')), ...(o.data === undefined ? {} : { data: scrub(o.data) }) };
    } catch {
      return { at: '', kind: 'engine', text: redact(l) };
    }
  });
}

function shot(res: ServerResponse, inspectionId: string, routeRaw: string, which: string): void {
  const i = inspectionById(idOf(inspectionId, 'inspection'));
  if (!i || (which !== 'before' && which !== 'after')) throw new HttpError(404, { error: 'no such shot' });
  const route = routeRaw.startsWith('/') ? routeRaw : `/${routeRaw}`;
  const found = i.design?.shots.find((s) => s.route === routeRaw || s.route === route);
  const real = insideRuns(found ? found[which] : null);
  if (!real || !real.toLowerCase().endsWith('.png')) throw new HttpError(404, { error: 'no such shot' });
  const png = readFileSync(real);
  res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length, 'cache-control': 'no-cache' });
  res.end(png);
}

// ------------------------------------------------------------------ treasury, reports

/** Whether his reading cannot speak for his plan now (none, a window missing, or stale): the test the treasury's stale pause uses. */
function readingUnreadable(now: number): boolean {
  const r = latestReading();
  return r === null || r.fiveHour === null || r.sevenDay === null || isStale(r, now);
}

/** The runs under way, asked of the store for the unended runs on live jobs only, never every row parsed. */
function underWayNow(): TreasuryView['underWay'] {
  const marks = LIVE_JOB_STATUSES.map(() => '?').join(', ');
  const rows = openDb()
    .prepare(`SELECT r.json AS run, j.id AS jobId, j.status AS status FROM runs r JOIN jobs j ON j.id = r.job_id WHERE j.status IN (${marks}) AND json_extract(r.json, '$.endedAt') IS NULL`)
    .all(...LIVE_JOB_STATUSES) as Array<{ run: string; jobId: string; status: JobStatus }>;
  return runsUnderWay(
    rows.map((r) => JSON.parse(r.run) as Run),
    rows.map((r) => ({ id: r.jobId, status: r.status })),
  );
}

function treasuryView(): TreasuryView {
  const now = Date.now();
  const c = storedCalibration();
  const settings = getSettings();
  const r = latestReading();
  const t = treasury(now);
  const resumeUntil = settings.resumeStaleUntil;
  // A resume is carrying the city only while the reading would otherwise pause it.
  const unreadable = readingUnreadable(now);
  const today = periodBounds('today', now);
  const week = periodBounds('week', now);
  return {
    ...t,
    balances: balances(),
    calibration: { tokensPerPct: c.value, samples: c.samples, calibrated: c.samples > 0 },
    hardStopPct: settings.hardStopPct,
    reading: r ? { at: r.at, stale: unreadable } : null,
    resumedUntil: unreadable && t.paused?.reason !== 'stale' && resumeUntil !== null && resumeUntil > now ? resumeUntil : null,
    spend: { today: spendBetween(today.from, today.to), week: spendBetween(week.from, week.to) },
    reports: [...new Set(query({ kind: 'report.written' }).map((e) => (e.data as { day?: string }).day).filter((d): d is string => typeof d === 'string' && DAY.test(d)))].sort().reverse(),
    // Counted from the runs store, as the board and the run pages count, never from the leases.
    underWay: underWayNow(),
  };
}

/** The credits entries behind a row of the treasury's spend tables. */
function creditsFor(params: URLSearchParams): CreditEntries {
  const period = params.get('period') ?? 'today';
  if (period !== 'today' && period !== 'week') throw new HttpError(400, { error: 'period is today or week' });
  const firm = params.get('firm');
  const model = params.get('model');
  if (firm !== null && firm !== CITY_KEY && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(firm)) throw new HttpError(400, { error: 'not a firm id' });
  if (model !== null && !/^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,127}$/.test(model)) throw new HttpError(400, { error: 'not a model' });
  const b = periodBounds(period, Date.now());
  return creditEntries({ fromMs: b.from, toMs: b.to, firm: firm ?? undefined, model: model ?? undefined });
}

function reportFor(day: string): ReportView {
  if (!DAY.test(day)) throw new HttpError(400, { error: 'a report is named by its day, YYYY-MM-DD' });
  const file = join(paths().reports, `${day}.md`);
  if (!existsSync(file)) throw new HttpError(404, { error: 'no report for that day' });
  const written = query({ kind: 'report.written' }).filter((e) => (e.data as { day?: string }).day === day).at(-1);
  return { day, markdown: readFileSync(file, 'utf8'), data: (written?.data as { data?: unknown } | undefined)?.data ?? null };
}

// ------------------------------------------------------------------ the router

/**
 * Answers the market routes. Returns false for a path it does not own, so the
 * caller can go on to the older routes; throws HttpError for a refused input.
 */
export async function handleMarketApi(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  search: URLSearchParams,
  opts: MarketApiOptions = {},
): Promise<boolean> {
  // Everything that reaches the page passes the same redaction as the event stream.
  const send = (status: number, body: unknown): true => {
    sendJson(res, status, scrub(body));
    return true;
  };
  let m: RegExpMatchArray | null;

  // jobs
  if (pathname === '/api/jobs' && method === 'GET') {
    const status = search.get('status');
    const repo = search.get('repo');
    if (status !== null && !JOB_STATUSES.includes(status as JobStatus)) throw new HttpError(400, { error: `status must be one of ${JOB_STATUSES.join(', ')}` });
    if (repo !== null && !isValidFullName(repo)) throw new HttpError(400, { error: BAD_NAME });
    return send(200, listJobs({ ...(status ? { status: status as JobStatus } : {}), ...(repo ? { repo } : {}) }));
  }
  if (pathname === '/api/jobs' && method === 'POST') return send(201, await postJob(req));
  if ((m = pathname.match(/^\/api\/jobs\/([^/]+)$/))) {
    if (method === 'GET') return send(200, jobDetail(mustJob(m[1])));
    if (method === 'PATCH') {
      const j = mustJob(m[1]);
      const b = await readObjectBody(req);
      if (!('tier' in b) && !('scope' in b) && !('acceptance' in b)) throw new HttpError(400, { error: 'expected { tier } or { scope, acceptance }' });
      const tier = 'tier' in b ? tierOf(b.tier) : undefined;
      const scope = list(b, 'scope');
      const acceptance = list(b, 'acceptance');
      if ('scope' in b && scope === undefined) throw new HttpError(400, { error: 'scope must be a list of up to 50 short texts' });
      // The scope and acceptance first: a refusal there changes nothing, tier included.
      let out: Job = j;
      if (scope !== undefined || acceptance !== undefined) out = moving(() => setScope(j.id, { scope, acceptance }));
      if (tier !== undefined) out = moving(() => setTier(j.id, tier));
      return send(200, out);
    }
  }
  if ((m = pathname.match(/^\/api\/jobs\/([^/]+)\/propose-again$/)) && method === 'POST') {
    const j = mustJob(m[1]);
    try {
      return send(200, proposeAgain(j.id));
    } catch (err) {
      if (err instanceof Error && /cannot be proposed again/.test(err.message)) throw new HttpError(409, { error: err.message });
      throw err;
    }
  }
  if ((m = pathname.match(/^\/api\/jobs\/([^/]+)\/(withdraw|repost|accept|dismiss|resume)$/)) && method === 'POST') {
    const j = mustJob(m[1]);
    switch (m[2]) {
      case 'withdraw':
        return send(200, await withdraw(j));
      case 'repost':
        if (j.status !== 'failed' || j.attempts >= MAX_ATTEMPTS) throw new HttpError(409, { error: 'only a failed job with attempts left can be reposted' });
        return send(200, moving(() => repost(j.id)));
      case 'accept':
        if (j.status !== 'proposed') throw new HttpError(409, { error: 'only a proposed job can be accepted' });
        return send(200, moving(() => transition(j, 'open')));
      case 'dismiss':
        if (j.status !== 'proposed') throw new HttpError(409, { error: 'only a proposed job can be dismissed' });
        return send(200, moving(() => transition(j, 'withdrawn', {}, { by: 'him' })));
      default:
        if (j.status !== 'halted') throw new HttpError(409, { error: 'the job is not halted' });
        if (getRepo(j.repo)?.halted) throw new HttpError(409, { error: `the market on ${j.repo} is halted: resume the repo first` });
        return send(200, moving(() => resumeJob(j)));
    }
  }

  // audits
  if (pathname === '/api/audits' && method === 'GET') {
    const repo = search.get('repo');
    if (repo !== null && !isValidFullName(repo)) throw new HttpError(400, { error: BAD_NAME });
    return send(200, listAudits(repo ? { repo } : {}).map(publicAudit));
  }
  if ((m = pathname.match(/^\/api\/audits\/([^/]+)$/)) && method === 'GET') return send(200, auditView(mustAudit(m[1])));
  if ((m = pathname.match(/^\/api\/audits\/([^/]+)\/kill$/)) && method === 'POST') {
    const a = mustAudit(m[1]);
    if (!killAudit(a.id, 'He stopped the audit.')) throw new HttpError(409, { error: 'the audit is not live' });
    return send(200, { ok: true });
  }
  if ((m = pathname.match(/^\/api\/repos\/([^/]+)\/([^/]+)\/audit$/)) && method === 'POST') return send(202, startAudit(m[1], m[2]));

  // the brief, milestones and the tour
  if (pathname === '/api/brief' && method === 'GET') return send(200, briefData(Date.now()));
  if (pathname === '/api/brief/open' && method === 'POST') return send(200, openBrief(Date.now()));
  if ((m = pathname.match(/^\/api\/brief\/items\/([^/]+)\/([^/]+)$/)) && method === 'POST') return send(200, await briefAction(req, m[1], m[2]));
  if (pathname === '/api/milestones' && method === 'GET') return send(200, listMilestones(Date.now(), { active: search.get('active') === '1' }));
  if (pathname === '/api/tour' && method === 'GET') {
    const week = search.get('week');
    if (week !== null && !DAY.test(week)) throw new HttpError(400, { error: 'a week is its Monday, YYYY-MM-DD' });
    return send(200, weekTour(week ?? Date.now()));
  }

  // firms and agents
  if (pathname === '/api/firms' && method === 'GET') {
    const log = reputationLog();
    const b = balances();
    return send(200, listFirms().map((f) => firmView(f, log, b)));
  }
  if ((m = pathname.match(/^\/api\/firms\/([^/]+)$/)) && method === 'GET') {
    const f = firm(idOf(m[1], 'firm'));
    if (!f) throw new HttpError(404, { error: 'unknown firm' });
    const ids = [...new Set(listRuns().filter((r) => r.firmId === f.id).map((r) => r.jobId))];
    const books = firmBooks(f.id);
    const detail: FirmDetail = {
      ...firmView(f),
      jobs: ids.map((id) => job(id)).filter((x): x is Job => x !== null),
      opening: books.opening,
      truncated: books.truncated,
      books: books.rows,
      rounds: firmRounds(f.id),
      reputationLine: reputationLine(f.id),
      deals: firmDeals(f.id),
    };
    return send(200, detail);
  }
  if ((m = pathname.match(/^\/api\/agents\/([^/]+)$/)) && method === 'GET') {
    const a = agent(idOf(m[1], 'agent'));
    if (!a) throw new HttpError(404, { error: 'unknown agent' });
    return send(200, agentDetail(a));
  }

  // runs and inspections
  if ((m = pathname.match(/^\/api\/runs\/([^/]+)$/)) && method === 'GET') {
    const r = mustRun(m[1]);
    const i = (r.inspectionId ? inspectionById(r.inspectionId) : null) ?? inspectionsOfRun(r.id).at(-1) ?? null;
    const detail: RunDetail = { ...publicRun(r), job: job(r.jobId), inspection: i ? inspectionView(i, false) : null };
    return send(200, detail);
  }
  if ((m = pathname.match(/^\/api\/runs\/([^/]+)\/log$/)) && method === 'GET') {
    const r = mustRun(m[1]);
    return send(200, logLines(r.id, search.get('since')));
  }
  if ((m = pathname.match(/^\/api\/runs\/([^/]+)\/diff$/)) && method === 'GET') {
    const r = mustRun(m[1]);
    const file = join(paths().runs, r.id, 'diff.patch');
    if (!existsSync(file)) throw new HttpError(404, { error: 'this run has no diff' });
    sendText(res, 200, homePathsOut(readFileSync(file, 'utf8').slice(0, DIFF_CAP)));
    return true;
  }
  if ((m = pathname.match(/^\/api\/runs\/([^/]+)\/kill$/)) && method === 'POST') {
    const r = mustRun(m[1]);
    if (!kill(r.id, 'He stopped the run.')) throw new HttpError(409, { error: 'the run is not live' });
    return send(200, { ok: true });
  }
  if ((m = pathname.match(/^\/api\/inspections\/([^/]+)$/)) && method === 'GET') {
    const i = inspectionById(idOf(m[1], 'inspection'));
    if (!i) throw new HttpError(404, { error: 'unknown inspection' });
    return send(200, inspectionView(i, true));
  }
  if ((m = pathname.match(/^\/api\/inspections\/([^/]+)\/shot\/(.+)\/([^/]+)$/)) && method === 'GET') {
    shot(res, m[1], m[2], m[3]);
    return true;
  }

  // treasury, reports, providers
  if (pathname === '/api/treasury' && method === 'GET') return send(200, treasuryView());
  if (pathname === '/api/treasury/credits' && method === 'GET') return send(200, creditsFor(search));
  if (pathname === '/api/treasury/resume-stale' && method === 'POST') {
    // Only a stale or unreadable reading can be resumed past: a resume taken now must not carry the city past a later one.
    if (!readingUnreadable(Date.now())) throw new HttpError(409, { error: 'not paused for a stale reading' });
    patchSettings({ resumeStaleUntil: Date.now() + MAX_RESUME_MS });
    return send(200, treasuryView());
  }
  if (pathname === '/api/report/latest' && method === 'GET') {
    const r = latestReport();
    if (!r) throw new HttpError(404, { error: 'no report yet' });
    return send(200, { day: r.day, markdown: r.markdown, data: r.data } satisfies ReportView);
  }
  if ((m = pathname.match(/^\/api\/report\/([^/]+)$/)) && method === 'GET') return send(200, reportFor(m[1]));
  if (pathname === '/api/providers' && method === 'GET') return send(200, await providerUsages(extras.providers ?? {}));
  // Whether a key is stored, and nothing else: the key itself never leaves the keychain through this engine.
  if (pathname === '/api/providers/anthropic/key' && method === 'GET') {
    let set = false;
    try {
      set = await apiKeyStored({ keychain: opts.keychain });
    } catch {
      set = false;
    }
    return send(200, { set });
  }
  if (pathname === '/api/providers/anthropic/key' && method === 'POST') {
    const b = await readObjectBody(req);
    const key = b.key;
    if (typeof key !== 'string' || key.length > 500) throw new HttpError(400, { error: 'expected { key }' });
    try {
      await setApiKey(key, { keychain: opts.keychain });
    } catch (err) {
      const msg = (err instanceof Error ? err.message : String(err)).split(key).join('[key]');
      if (msg.startsWith('That is not')) throw new HttpError(400, { error: msg });
      throw new HttpError(502, { error: redact(msg) });
    }
    return send(200, { ok: true });
  }
  if (pathname === '/api/providers/anthropic/key' && method === 'DELETE') {
    try {
      await removeApiKey({ keychain: opts.keychain });
    } catch (err) {
      throw new HttpError(502, { error: redact(err instanceof Error ? err.message : String(err)) });
    }
    return send(200, { ok: true });
  }

  // the city
  if (pathname === '/api/quarters' && method === 'GET') return send(200, quarters());
  // The trips under way now; one whose time is up ends as arrived on this look.
  if (pathname === '/api/live' && method === 'GET') return send(200, { sites: [...sites(), ...(extras.sites?.() ?? [])], trips: activeTrips() } satisfies LiveView);

  return false;
}
