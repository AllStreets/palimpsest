/**
 * The audit runner (Phase 3 Task 4): a short lifecycle over the same
 * functions a market run uses, read-only and charged to the city.
 *
 * An audit is queued `waiting` by a trigger (the market switch, the end of
 * an analysis, his click) and started by the scheduler's tick, outside its
 * market-on filter: the oldest waiting audit starts when the preflight
 * passes, no other audit is live city-wide, a model is picked (ruling 5)
 * and, for an automatic one, his Claude session is quiet. It then runs
 * `preparing` (a fresh clone of the mirror, the egress proxy, the broker
 * for Claude), `installing` (the repo's install command, sandboxed, only
 * when there is a check to run afterwards), `reading` (the provider's
 * read-only session over the README and docs read from the base commit),
 * then the clone is checked clean, the answer parsed and its evidence
 * verified at the base commit, the page rendered and the spend charged
 * under kind `audit`. It never commits, diffs, ships or pushes: nothing in
 * its clone is ever shipped.
 *
 * Kill paths are a run's: the stop file at every stage boundary and in the
 * watcher, the wall deadline, the hard stop, his click and the shutdown.
 * A killed, capped, crashed or failed audit proposes nothing, halts no
 * repo and strikes no firm (ruling 14).
 */
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AUDIT_CAPS, AUDIT_ESTIMATE, localSize } from '../../shared/market-rules.js';
import type { Audit, AuditStatus, AuditTrigger, ModelRef, Repo, RunProgress, Settings } from '../../shared/types.js';
import { emit } from '../events.js';
import { openDb } from '../db.js';
import { paths } from '../home.js';
import { record } from '../ledger.js';
import { getRepo, registerAuditTrigger, updateRepoMarket } from '../repos.js';
import { getSettings } from '../settings.js';
import { interactiveActive } from '../usage.js';
import { chargesItself } from '../market/anthropic-api.js';
import { forgetRun, startBroker, type Broker, type ToolStage } from '../market/broker.js';
import { abortLease, acquire, callPaused, charge, creditsFor, unattended, type Lease } from '../market/budget.js';
import { hostsFor, startEgress, type Egress } from '../market/egress.js';
import { lastInstalled } from '../market/firms.js';
import { installDeps as defaultInstallDeps, type InstallDeps, type RunContext } from '../market/install.js';
import { redact } from '../market/jobs.js';
import type { AuditResult, RunLogLine, Usage } from '../market/provider.js';
import { providerFor } from '../market/providers.js';
import { reapRun, runQuiet } from '../market/reaper.js';
import { INTERRUPTED_RUN, LOG_PER_SECOND, RUN_EXTRA_MINUTES, STOP_REASON } from '../market/runs.js';
import { createRunDir, engineGit, removeRunDir } from '../market/worktree.js';
import { auditSlug, checkCommands, cloneClean, countVerdicts, parseAudit, readCapOf, renderAudit, verifyEvidence } from './schema.js';
import { audit as storedAudit, latestAudit, listAudits, OPEN_AUDIT, saveAudit, LIVE_AUDIT } from './store.js';

// ---------------------------------------------------------------- constants

const MIN_MS = 60_000;
/** Why an automatic audit waits while he is using Claude Code (ruling 6). */
export const WAITING_INTERACTIVE = 'waiting for your Claude session to go quiet';
/** Why an audit waits when Claude is paused and no local model is installed (ruling 5). */
export const WAITING_MODEL = 'waiting for Claude: it is paused and no Ollama model is installed';
/** The reason a written clone ends the audit (ruling 3). */
export const WROTE_CLONE = 'the audit wrote to its clone';
/** How many docs files are read from the base commit at most; the prompt caps their text anyway. */
const MAX_DOCS = 40;

const ZERO_COUNTS = { REAL: 0, PARTIAL: 0, MISSING: 0, STUBBED: 0, BROKEN: 0 } as const;

// ---------------------------------------------------------------- live audits

class Killed extends Error {}

interface LiveAudit {
  audit: Audit;
  repo: Repo;
  model: ModelRef;
  lease: Lease;
  runRoot: string;
  egress: Egress | null;
  broker: Broker | null;
  toolStage: ToolStage;
  killReason: string | null;
  logWindow: { start: number; count: number };
  /** Set when the repo's declared test check ran through the run tool and exited 0 during the session. */
  checksPassed: boolean;
  wallMs: number;
  deadlineAt: number;
  deadlineHit: boolean;
  /** Resolves once the lifecycle has closed, reaped and released. */
  settled: Promise<Audit>;
}

const live = new Map<string, LiveAudit>();
/** True between the pick of a waiting audit and its entry in `live`, so two ticks never start two. */
let starting = false;
/** Set while killLiveAudits waits for the live audits to settle (the shutdown), so no queued audit starts meanwhile. */
let stopping = false;

export interface StartOptions {
  now: () => number;
  /** Why no agent run may start, or null (the scheduler's preflight). */
  preflight: () => Promise<string | null>;
  quiet?: (runRoot: string) => Promise<void>;
  reap?: (runRoot: string) => Promise<number[]>;
  installDeps?: InstallDeps;
  /** The installed Ollama models (default: the last `ollama list` the engine took). */
  installed?: string[];
  /** The whole wall time of an audit; past it the watcher ends it `capped`. Default the session cap plus RUN_EXTRA_MINUTES. */
  wallMs?: number;
  /** Called when an audit becomes live and when it leaves (the scheduler arms its watcher on it). */
  onLive?: () => void;
}

const iso = (ms: number) => new Date(ms).toISOString();
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function auditLogPath(id: string): string {
  return join(paths().runs, id, 'log.jsonl');
}

/** Ids of the audits live in this process now. */
export function liveAuditsNow(): string[] {
  return [...live.keys()];
}

/** The run roots of the audits live now, for the shutdown's last reap. */
export function liveAuditRoots(): string[] {
  return [...live.values()].map((st) => st.runRoot);
}

// ---------------------------------------------------------------- the queue and the triggers

/**
 * Ruling 6: an audit runs by itself only on a ready repo whose market is on,
 * while the setting holds, and only when the repo was never audited (a
 * capped, failed or crashed audit counts: it is never retried by itself).
 */
export function shouldAutoAudit(repo: Repo, settings: Settings): boolean {
  return repo.market && repo.status === 'ready' && settings.auditOnConnect && latestAudit(repo.fullName) === null;
}

// The two triggers of ruling 6 (the market switch and the end of an analysis) call this from repos.ts.
registerAuditTrigger((repo) => {
  if (shouldAutoAudit(repo, getSettings())) queueAudit(repo, 'connect');
});

/**
 * Queues an audit of `repo` as `waiting`, recording and emitting
 * `audit.started`. Throws when the repo already has an audit waiting or
 * under way (at most one per repo).
 */
export function queueAudit(repo: Repo, trigger: AuditTrigger, now: number = Date.now()): Audit {
  if (listAudits({ repo: repo.fullName, status: [...OPEN_AUDIT] }).length > 0) {
    throw new Error(`${repo.fullName} already has an audit waiting or under way`);
  }
  const a: Audit = {
    id: `audit-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    repo: repo.fullName,
    model: null,
    trigger,
    baseSha: null,
    status: 'waiting',
    waitingReason: null,
    startedAt: iso(now),
    endedAt: null,
    endedReason: null,
    findings: [],
    counts: { ...ZERO_COUNTS },
    unverified: 0,
    claimsRead: 0,
    credits: 0,
    unattended: unattended(now),
    markdownPath: null,
  };
  saveAudit(a);
  record('audit.started', { auditId: a.id, repo: a.repo, trigger, audit: a });
  emit('audit.started', { audit: a });
  return a;
}

/**
 * Ruling 5: a chosen model as it is; `auto` is `claude:sonnet` while it may
 * be called, else the installed Ollama model whose name says `coder` with
 * the largest parameter tag, else any installed one by the same rank, else
 * null (the audit waits for Claude).
 */
export function pickAuditModel(settings: Settings, installed: string[], now: number): ModelRef | null {
  if (settings.auditModel !== 'auto') return settings.auditModel;
  if (callPaused('claude:sonnet', AUDIT_ESTIMATE, now) === null) return 'claude:sonnet';
  const ranked = (names: string[]) => [...names].sort((a, b) => localSize(b) - localSize(a) || a.localeCompare(b));
  const coders = ranked(installed.filter((n) => /coder/i.test(n)));
  const pick = coders[0] ?? ranked(installed)[0];
  return pick ? (`ollama:${pick}` as ModelRef) : null;
}

/** Writes a waiting audit's reason, recording the stage only when the reason changes (a tick is every 15 s). */
function setWaiting(a: Audit, reason: string | null): Audit {
  const clean = reason === null ? null : redact(reason);
  if (a.waitingReason === clean) return a;
  const next: Audit = { ...a, waitingReason: clean };
  saveAudit(next);
  record('audit.stage', { auditId: a.id, status: 'waiting', waitingReason: clean });
  emit('audit.stage', { auditId: a.id, status: 'waiting', waitingReason: clean });
  return next;
}

/**
 * Starts the oldest waiting audit when it may start (see the module
 * comment) and resolves with it once it has ended; null when nothing
 * started this tick. A connect audit that must wait on his session is
 * given the reason and left waiting; one with no model likewise.
 */
export async function startQueuedAudit(o: StartOptions): Promise<Audit | null> {
  if (starting || stopping || live.size > 0) return null;
  const waiting = listAudits({ status: ['waiting'] });
  const next = waiting[waiting.length - 1];
  if (!next) return null;
  starting = true;
  let lease: Lease | null = null;
  try {
    const now = o.now();
    const repo = getRepo(next.repo);
    if (!repo || !repo.connected) {
      // The repo left while the audit waited: the row goes, so a reconnect still gets its one automatic audit.
      dropWaiting(next);
      return null;
    }
    const problem = await o.preflight();
    if (stopping) return null;
    if (problem) {
      setWaiting(next, problem);
      return null;
    }
    const model = pickAuditModel(getSettings(), o.installed ?? lastInstalled(), now);
    if (!model) {
      setWaiting(next, WAITING_MODEL);
      return null;
    }
    if (next.trigger === 'connect' && interactiveActive(now)) {
      setWaiting(next, WAITING_INTERACTIVE);
      return null;
    }
    const got = await acquire(model, 'work', AUDIT_ESTIMATE, { now });
    if (stopping) {
      if (got.ok) got.lease.release();
      return null;
    }
    if (!got.ok) {
      setWaiting(next, got.reason.detail);
      return null;
    }
    lease = got.lease;
    const st = begin(storedAudit(next.id) ?? next, repo, model, lease, o);
    lease = null;
    // Live now: the next tick's check is `live`, so a second start may be refused on that alone.
    starting = false;
    return await st.settled;
  } catch (err) {
    lease?.release();
    throw err;
  } finally {
    starting = false;
  }
}

/** Removes an audit that never left the queue (its repo was disconnected): nothing ran, nothing is recorded as ended. */
function dropWaiting(a: Audit): void {
  openDb().prepare('DELETE FROM audits WHERE id = ? AND status = ?').run(a.id, 'waiting');
  record('audit.stage', { auditId: a.id, status: 'waiting', waitingReason: null, dropped: true, at: new Date().toISOString() });
  emit('audit.dropped', { auditId: a.id, repo: a.repo });
}

// ---------------------------------------------------------------- one audit

function capsOf(model: ModelRef): { maxTurns: number; maxMinutes: number } {
  return model.startsWith('claude:') || model.startsWith('anthropic:') ? AUDIT_CAPS.claude : AUDIT_CAPS.local;
}

function logTo(st: LiveAudit): (line: RunLogLine) => void {
  return (line) => {
    try {
      appendFileSync(join(st.runRoot, 'log.jsonl'), JSON.stringify(line) + '\n');
    } catch {
      // A log write must never stop the audit.
    }
    noteExit(st, line);
    const t = Date.now();
    if (t - st.logWindow.start >= 1000) st.logWindow = { start: t, count: 0 };
    if (st.logWindow.count < LOG_PER_SECOND) {
      st.logWindow.count++;
      emit('audit.log', { auditId: st.audit.id, line });
    }
  };
}

/** The run tool's exit line (broker.ts execTool): the declared test check passing during the session is what vouches for REAL. */
function noteExit(st: LiveAudit, line: RunLogLine): void {
  if (st.audit.status !== 'reading' || line.kind !== 'engine') return;
  const exit = (line.data as { exit?: { command?: unknown; code?: unknown } } | undefined)?.exit;
  const test = st.repo.checks?.test?.trim();
  if (exit && test && typeof exit.command === 'string' && exit.command.trim() === test && exit.code === 0) st.checksPassed = true;
}

function engineLog(st: LiveAudit, text: string): void {
  logTo(st)({ at: new Date().toISOString(), kind: 'engine', text });
}

function reasonOf(st: LiveAudit): string {
  if (st.killReason) return st.killReason;
  const r = st.lease.signal.reason;
  const msg = r instanceof Error ? r.message : String(r ?? '');
  if (msg === 'budget: hard') return 'The hard stop: a usage window reached the hard stop, so Claude work stopped.';
  if (msg === 'budget: stopped') return STOP_REASON;
  return msg || 'The audit was stopped.';
}

function setStage(st: LiveAudit, status: AuditStatus, extra: Partial<Pick<Audit, 'model' | 'baseSha' | 'unattended' | 'startedAt'>> = {}, now: number = Date.now()): void {
  st.audit = { ...st.audit, ...extra, status, waitingReason: null };
  saveAudit(st.audit);
  const data = { auditId: st.audit.id, status, waitingReason: null, ...extra, at: iso(now) };
  record('audit.stage', data);
  emit('audit.stage', data);
}

function checkpoint(st: LiveAudit): void {
  if (existsSync(paths().stop)) killAudit(st.audit.id, STOP_REASON);
  if (st.lease.signal.aborted) throw new Killed(reasonOf(st));
}

/** Awaits `p` unless the audit's signal fires first, so a stage that ignores the signal cannot hold the audit past a kill. */
function guarded<T>(st: LiveAudit, p: Promise<T>): Promise<T> {
  const s = st.lease.signal;
  if (s.aborted) {
    p.catch(() => {});
    return Promise.reject(new Killed(reasonOf(st)));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      p.catch(() => {});
      reject(new Killed(reasonOf(st)));
    };
    s.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        s.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        s.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

function cleanUsage(u: unknown): Usage {
  const o = (u && typeof u === 'object' ? u : {}) as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
  return { weightedTokens: n(o.weightedTokens), seconds: n(o.seconds), usd: n(o.usd), credits: n(o.credits) };
}

/** Charges the session to the city under kind `audit`, once: the Anthropic API backend charges its own calls. */
function chargeAudit(st: LiveAudit, usage: Usage, now: number): number {
  const clean = cleanUsage(usage);
  if (providerFor(st.model).kind === 'anthropic' && chargesItself) return creditsFor(st.model, clean);
  try {
    return charge({ runId: st.audit.id, firmId: null, model: st.model, kind: 'audit', usage: clean, unattended: st.audit.unattended, at: now, lease: st.lease });
  } catch (err) {
    engineLog(st, `[palimpsest] the audit could not be charged: ${errText(err)}`);
    return creditsFor(st.model, clean);
  }
}

/** The README (any case, .md, .rst or .txt, at the root) and every Markdown file under docs/, read from the base commit through the engine's git (ruling 1). */
async function readingFrom(dir: string, baseSha: string, model: ModelRef): Promise<{ readme: { path: string; text: string } | null; docs: Array<{ path: string; text: string }> }> {
  const ls = await engineGit(dir, ['ls-tree', '-r', '-z', '--name-only', baseSha]);
  if (ls.code !== 0) throw new Error(`git ls-tree failed: ${ls.stderr.trim()}`);
  const names = ls.stdout.split('\0').filter(Boolean);
  const readmes = names.filter((n) => /^readme(\.(md|markdown|rst|txt))?$/i.test(n));
  const rank = (n: string) => (/\.(md|markdown)$/i.test(n) ? 0 : /\.rst$/i.test(n) ? 1 : 2);
  readmes.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const docNames = names.filter((n) => /^docs\/.+\.(md|markdown)$/i.test(n)).sort().slice(0, MAX_DOCS);
  const show = async (path: string) => {
    const r = await engineGit(dir, ['show', `${baseSha}:${path}`]);
    if (r.code !== 0) throw new Error(`git show ${path} failed: ${r.stderr.trim()}`);
    return { path, text: r.stdout };
  };
  const readme = readmes[0] ? await show(readmes[0]) : null;
  const cap = readCapOf(model);
  let total = readme?.text.length ?? 0;
  const docs: Array<{ path: string; text: string }> = [];
  for (const n of docNames) {
    // Past the model's read cap the prompt would only name the file by its size; stop reading.
    if (total >= cap) break;
    const d = await show(n);
    docs.push(d);
    total += d.text.length;
  }
  return { readme, docs };
}

function end(st: LiveAudit, status: Exclude<AuditStatus, 'waiting' | 'preparing' | 'installing' | 'reading'>, reason: string | null, now: number, patch: Partial<Audit> = {}): Audit {
  st.audit = { ...st.audit, ...patch, status, endedReason: reason === null ? null : redact(reason), endedAt: iso(now), waitingReason: null };
  saveAudit(st.audit);
  record('audit.ended', { auditId: st.audit.id, repo: st.audit.repo, status, reason: st.audit.endedReason, audit: st.audit });
  emit('audit.ended', { audit: st.audit });
  if (status === 'done') {
    try {
      updateRepoMarket(st.audit.repo, { auditedAt: st.audit.endedAt });
    } catch (err) {
      engineLog(st, `[palimpsest] the repo's audit date could not be written: ${errText(err)}`);
    }
  }
  engineLog(st, `audit ended ${status}${st.audit.endedReason ? `: ${st.audit.endedReason}` : ''}`);
  return st.audit;
}

/** How long a killed session is given to hand back what it spent before the audit ends without it. */
const KILL_GRACE_MS = 4_000;

/**
 * Awaits the session and charges what it spent. A kill aborts the session
 * through its signal; the provider is given a short grace to return with
 * its usage (so a killed audit's spend still counts in the caps), and the
 * audit then ends as killed whether it did or not.
 */
async function settled(st: LiveAudit, session: Promise<AuditResult>, now: () => number): Promise<AuditResult> {
  const book = (out: AuditResult) => {
    const credits = chargeAudit(st, out.usage, now());
    st.audit = { ...st.audit, credits: Math.round((st.audit.credits + credits) * 1e6) / 1e6 };
    saveAudit(st.audit);
  };
  let out: AuditResult;
  try {
    out = await guarded(st, session);
  } catch (err) {
    // A session past its wall deadline is presumed hung: it gets no grace.
    if (!(err instanceof Killed) || st.deadlineHit) throw err;
    const late = await Promise.race([session.then((o) => o, () => null), new Promise<null>((r) => setTimeout(() => r(null), KILL_GRACE_MS))]);
    if (late) book(late);
    throw err;
  }
  book(out);
  if (out.ended === 'aborted' && st.lease.signal.aborted) throw new Killed(reasonOf(st));
  return out;
}

/** Whether the install stage has anything to serve: an install command, and a check the session could run afterwards. */
function needsInstall(repo: Repo): boolean {
  return !!repo.checks?.install && checkCommands(repo.checks).length > 0;
}

async function lifecycle(st: LiveAudit, o: StartOptions): Promise<Audit> {
  const log = logTo(st);
  const quiet = o.quiet ?? runQuiet;
  const reap = o.reap ?? reapRun;
  const installDeps = o.installDeps ?? defaultInstallDeps;
  const ecosystems = st.repo.checks?.ecosystems ?? [];
  const checks = checkCommands(st.repo.checks);
  try {
    checkpoint(st);
    const { dir, baseSha } = await guarded(st, createRunDir(st.repo, st.audit.id, `palimpsest/${st.audit.id}`));
    st.egress = await guarded(st, startEgress(st.audit.id, log));
    if (st.model.startsWith('claude:')) {
      st.broker = await guarded(st, startBroker(st.audit.id, { runRoot: st.runRoot, dir, log, signal: st.lease.signal, stage: () => st.toolStage, allowedCommands: checks }));
    }

    checkpoint(st);
    setStage(st, 'installing', { baseSha }, o.now());
    st.toolStage = 'install';
    st.egress.setStage('install', hostsFor('install', ecosystems, null));
    if (needsInstall(st.repo)) {
      const ctx: RunContext = { runId: st.audit.id, runRoot: st.runRoot, dir, log, signal: st.lease.signal, egress: st.egress };
      const install = await guarded(st, installDeps(ctx, st.repo));
      checkpoint(st);
      if (install.status === 'fail') return end(st, 'failed', `The install failed: ${install.detail}`, o.now());
    } else {
      engineLog(st, checks.length ? '[palimpsest] nothing to install' : '[palimpsest] no check to run, so nothing is installed');
    }

    checkpoint(st);
    setStage(st, 'reading', {}, o.now());
    st.toolStage = 'working';
    st.egress.setStage('working', hostsFor('working', ecosystems, st.model));
    const { readme, docs } = await guarded(st, readingFrom(dir, baseSha, st.model));
    const caps = { ...capsOf(st.model), maxCredits: getSettings().auditMaxCredits };
    const onProgress = (p: Partial<RunProgress>) => emit('audit.progress', { auditId: st.audit.id, progress: p });
    const session = providerFor(st.model).audit({ repo: st.repo, auditId: st.audit.id, dir, baseSha, readme, docs, checks: st.repo.checks, model: st.model, log, onProgress, signal: st.lease.signal, caps });
    const out = await settled(st, session, o.now);
    checkpoint(st);
    if (out.ended === 'capped') return end(st, 'capped', out.reason ?? 'The audit reached a cap.', o.now());
    if (out.ended === 'crashed' || out.ended === 'aborted') {
      return end(st, 'crashed', out.reason ?? (out.ended === 'aborted' ? 'The provider stopped on its own.' : 'The provider crashed.'), o.now());
    }

    // The session is over: nothing of it may still run, and the clone must be as the commit left it (ruling 3).
    await guarded(st, quiet(st.runRoot));
    const written = await guarded(st, cloneClean(dir));
    if (written.length) {
      engineLog(st, `[palimpsest] the clone was written: ${written.slice(0, 20).join(', ')}`);
      return end(st, 'failed', WROTE_CLONE, o.now());
    }
    const parsed = parseAudit(out.answer, out.text, st.repo.fullName);
    if ('error' in parsed) {
      engineLog(st, `[palimpsest] the answer was kept in this log only: ${out.text.slice(0, 20_000)}`);
      return end(st, 'failed', parsed.error, o.now());
    }
    const findings = await guarded(st, verifyEvidence(parsed.findings, dir, baseSha, { checksPassed: st.checksPassed }));
    const done: Audit = {
      ...st.audit,
      findings,
      counts: countVerdicts(findings),
      unverified: findings.filter((f) => f.unverified).length,
      claimsRead: parsed.claims,
    };
    const pageDir = join(paths().reports, 'audits');
    mkdirSync(pageDir, { recursive: true });
    const markdownPath = join(pageDir, `${auditSlug(st.repo.fullName, st.audit.id)}.md`);
    const endedMs = o.now();
    writeFileSync(markdownPath, renderAudit({ ...done, status: 'done', endedAt: iso(endedMs), markdownPath }, { repoDescription: st.repo.description }));
    return end(st, 'done', null, endedMs, { ...done, markdownPath });
  } catch (err) {
    if (st.deadlineHit) return end(st, 'capped', reasonOf(st), o.now());
    if (st.lease.signal.aborted || err instanceof Killed) return end(st, 'killed', reasonOf(st), o.now());
    return end(st, 'failed', errText(err), o.now());
  } finally {
    for (const close of [() => st.broker?.close(), () => st.egress?.close()]) {
      try {
        await close();
      } catch {
        // Closing is best effort; the registry entry goes with the audit.
      }
    }
    try {
      if (existsSync(st.runRoot)) await reap(st.runRoot);
    } catch (err) {
      console.warn(`palimpsest: reaping audit ${st.audit.id} failed: ${errText(err)}`);
    }
    forgetRun(st.audit.id);
    removeRunDir(st.audit.id);
    live.delete(st.audit.id);
    st.lease.release();
    o.onLive?.();
  }
}

/** Makes the audit live: its model, its root, its deadline, and `preparing` in the ledger. */
function begin(a: Audit, repo: Repo, model: ModelRef, lease: Lease, o: StartOptions): LiveAudit {
  const now = o.now();
  const runRoot = join(paths().runs, a.id);
  mkdirSync(runRoot, { recursive: true });
  const wallMs = o.wallMs ?? (capsOf(model).maxMinutes + RUN_EXTRA_MINUTES) * MIN_MS;
  const st: LiveAudit = {
    audit: a,
    repo,
    model,
    lease,
    runRoot,
    egress: null,
    broker: null,
    toolStage: 'working',
    killReason: null,
    logWindow: { start: 0, count: 0 },
    checksPassed: false,
    wallMs,
    deadlineAt: now + wallMs,
    deadlineHit: false,
    settled: Promise.resolve(a),
  };
  live.set(a.id, st);
  o.onLive?.();
  // The queue time gave way: from here `startedAt` is the real start, and the stage carries it for replay.
  setStage(st, 'preparing', { model, unattended: unattended(now), startedAt: iso(now) }, now);
  st.settled = lifecycle(st, o);
  return st;
}

// ---------------------------------------------------------------- kills, the watcher and the restart

/** Aborts a live audit's session, commands and checks; it ends `killed`. False when the audit is not live. */
export function killAudit(id: string, reason: string): boolean {
  const st = live.get(id);
  if (!st) return false;
  if (!st.killReason && !st.lease.signal.aborted) st.killReason = reason;
  abortLease(st.lease, new Error(reason));
  return true;
}

/** Kills every live audit and waits until each has closed, been reaped and released. */
export async function killLiveAudits(reason: string): Promise<void> {
  stopping = true;
  const all = [...live.values()];
  for (const st of all) killAudit(st.audit.id, reason);
  await Promise.allSettled(all.map((st) => st.settled));
}

/** The watcher's pass over the audits: the stop file kills them, and one past its wall deadline ends `capped`. */
export function watchAudits(now: number): void {
  if (existsSync(paths().stop)) for (const id of [...live.keys()]) killAudit(id, STOP_REASON);
  for (const st of [...live.values()]) {
    if (st.deadlineHit || st.lease.signal.aborted || now < st.deadlineAt) continue;
    st.deadlineHit = true;
    killAudit(st.audit.id, `The audit passed its wall deadline of ${Math.round(st.wallMs / MIN_MS)} minutes.`);
  }
}

/**
 * At engine start: audits left `preparing`, `installing` or `reading` by the
 * last engine can never finish. Each ends `crashed` after its strays are
 * reaped and its root removed but for the log; waiting ones stay queued.
 */
export async function failInterruptedAudits(opts: { reap?: (runRoot: string) => Promise<number[]> } = {}): Promise<Audit[]> {
  const reap = opts.reap ?? reapRun;
  const out: Audit[] = [];
  for (const a of listAudits({ status: [...LIVE_AUDIT] })) {
    if (live.has(a.id)) continue;
    const ended: Audit = { ...a, status: 'crashed', endedReason: INTERRUPTED_RUN, endedAt: new Date().toISOString(), waitingReason: null };
    saveAudit(ended);
    record('audit.ended', { auditId: a.id, repo: a.repo, status: 'crashed', reason: INTERRUPTED_RUN, audit: ended });
    emit('audit.ended', { audit: ended });
    const runRoot = join(paths().runs, a.id);
    try {
      if (existsSync(runRoot)) await reap(runRoot);
    } catch (err) {
      console.warn(`palimpsest: reaping interrupted audit ${a.id} failed: ${errText(err)}`);
    }
    removeRunDir(a.id);
    out.push(ended);
  }
  return out;
}

/** Forgets every live audit. For tests (runs.ts resetRuns calls it). */
export function resetAudits(): void {
  for (const st of live.values()) abortLease(st.lease, new Error('reset'));
  live.clear();
  starting = false;
  stopping = false;
}
