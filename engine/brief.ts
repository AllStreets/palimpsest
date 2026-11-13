/**
 * The morning brief (spec 11, Phase 3 Task 6): what happened since his last
 * look and what waits on him, with the one or two actions each line offers.
 *
 * The window (ruling 8): `since` is the first `brief.opened` of the previous
 * day he opened the app, or a day ago when there is none. Items come from
 * the ledger over [since, now] (merges, failures, reverts, notes, audits,
 * milestones) and from the live state (open PRs, proposals, halts, repos
 * never audited, the usage windows, a stale reading, the week's tour).
 * Two windows opened the same day therefore carry the same items; the
 * second says `firstOpen: false`. The numbers come from the day's report
 * data and the stored reports of the days in the window, never recomputed.
 *
 * The ledger (Decision 8): one `brief.opened` a day, empty morning or not,
 * listing the item ids shown, and a `brief.action` for each thing he does.
 * No `seen` rows. Every text goes through `plain()`, which redacts.
 */
import { localDay } from '../shared/day.js';
import { MAX_ATTEMPTS } from '../shared/market-rules.js';
import type { RawRow } from '../shared/net-features.js';
import { AGREE, WORK_KINDS } from '../shared/school-rules.js';
import type { Audit, Brief, BriefAction, BriefItem, BriefItemKind, Grant, Job, Milestone, Repo, Run, Tier, Tour, WorkKind } from '../shared/types.js';
import { queueAudit } from './audit/run.js';
import { latestAudit, listAudits } from './audit/store.js';
import { emit } from './events.js';
import { query, record, type LedgerEntry } from './ledger.js';
import { treasury } from './market/budget.js';
import { listFirms } from './market/firms.js';
import { acceptProposed, dismissProposed, job as storedJob, listJobs, plain, redact, repost, setTier } from './market/jobs.js';
import { listMilestones, weekTour } from './market/milestones.js';
import { claimOf, latestReport, num, reportData, type ReportData } from './market/report.js';
import { listRuns, resumeRepo } from './market/runs.js';
import { getRepo, listRepos } from './repos.js';
import { decline, grant, grants, kindWords, revoke } from './school/autonomy.js';
import { repoAcceptShare } from './school/datasets.js';
import { predict } from './school/decisions.js';
import { getSettings, patchSettings } from './settings.js';

const DAY_MS = 24 * 3_600_000;
const TIERS: readonly Tier[] = ['low', 'normal', 'high'];
/** A window within this many points of the cap puts the usage line in the brief. */
const USAGE_MARGIN = 10;
/** The actions that teach Triage something about what he wants (ruling 9), and (Phase 4) his answers on autonomy. */
const TAUGHT: readonly BriefAction[] = ['dismiss', 'accept', 'tier', 'retry', 'cap', 'grant', 'decline', 'revoke'];
/** The actions that finish an item: once taken, the item shows it and offers nothing else. A cap can be changed again. */
const FINISHING: readonly BriefAction[] = ['accept', 'dismiss', 'retry', 'resume', 'audit', 'grant', 'decline', 'revoke'];
/** Looking, not acting: recorded, but never covering what he did with the item (he may ask why after posting it). */
const LOOKS: readonly BriefAction[] = ['why', 'diff', 'fly', 'open-pr'];
/** Whether `next` should stand as the item's action over `was`. */
const covers = (was: BriefItem['acted'], next: BriefAction): boolean => !was || !LOOKS.includes(next) || LOOKS.includes(was.action);

export interface BriefOptions {
  /** The milestones active now; by default Task 7's `listMilestones`. */
  milestones?: () => Milestone[];
  /** The tour of the week that `week` (a Monday, YYYY-MM-DD) starts; by default Task 7's `weekTour`. */
  tour?: (week: string) => Tour | null;
}

/** The options with Task 7's milestones and tour wired in where the caller gave none. */
function wired(opts: BriefOptions, now: number): Required<BriefOptions> {
  return {
    milestones: opts.milestones ?? (() => listMilestones(now, { active: true })),
    tour: opts.tour ?? ((week) => weekTour(week)),
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
const sentence = (s: string) => (!s || /[.!?)]$/.test(s) ? s : `${s}.`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function listOf(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

/** The local day the brief belongs to. */
export function briefDay(now: number): string {
  return localDay(now);
}

/**
 * The start of the brief's window (ruling 8): the first `brief.opened` of
 * the most recent local day before today that has one, else 24 hours ago.
 * Once today has an open, its stored `since` is the answer, so a second
 * window the same day reads the same window as the first.
 */
export function briefSince(now: number): string {
  const today = localDay(now);
  const first = new Map<string, LedgerEntry>();
  for (const e of query({ kind: 'brief.opened' })) {
    const day = (e.data as { day?: string }).day ?? localDay(Date.parse(e.at));
    if (!first.has(day)) first.set(day, e);
  }
  const todays = first.get(today);
  const stored = (todays?.data as { since?: string } | undefined)?.since;
  if (stored) return stored;
  const prev = [...first.keys()].filter((d) => d < today).sort().at(-1);
  return prev ? first.get(prev)!.at : iso(now - DAY_MS);
}

// ---------------------------------------------------------------- the items

interface Draft {
  id: string;
  kind: BriefItemKind;
  repo: string | null;
  title: string;
  text: string;
  at: string;
  tier?: Tier | null;
  refs?: BriefItem['refs'];
  actions: BriefAction[];
}

function toItem(d: Draft): BriefItem {
  return {
    id: d.id,
    kind: d.kind,
    repo: d.repo ? redact(d.repo) : null,
    title: plain(d.title, 240),
    text: plain(d.text, 600),
    at: d.at,
    tier: d.tier ?? null,
    refs: d.refs ?? {},
    actions: d.actions,
    acted: null,
  };
}

/** Why a job failed: the run's end reason, in the report's words. */
function whyFailed(jobId: string, beforeId: number): string {
  const ended = query({ kind: 'run.ended', jobId }).filter((e) => e.id < beforeId).at(-1);
  if (!ended) return 'No run on record says why.';
  const d = ended.data as { reason?: string | null; outcome?: string };
  return sentence(d.reason ? d.reason.trim() : `The run ended ${d.outcome ?? 'without a reason'}`);
}

/** What an audit found, in one line: "3 claims read: 1 real, 1 partial, 1 missing; 1 job proposed." */
function auditLine(a: Audit): string {
  if (a.status !== 'done') return sentence(`The audit ended ${a.status}${a.endedReason ? `: ${a.endedReason}` : ''}`);
  if (a.claimsRead === 0) return 'No README to check.';
  const counts = (Object.entries(a.counts) as Array<[string, number]>).filter(([, n]) => n > 0).map(([v, n]) => `${n} ${v.toLowerCase()}`);
  const proposed = a.findings.filter((f) => f.proposal?.jobId).length;
  return `${plural(a.claimsRead, 'claim')} read${counts.length ? `: ${listOf(counts)}` : ''}${proposed ? `; ${plural(proposed, 'job')} proposed` : ''}.`;
}

/** The claim a proposal answers, else the first line of its body after the city's marker. */
function proposalText(j: Job): string {
  const claim = claimOf(j);
  if (claim) return `The README says "${claim}", and the code does not do it yet.`;
  const body = j.body.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('['));
  return body[0] ?? j.title;
}

/** The brief item of an ask: `autonomy:<kind>:<repo>` (ruling 17). */
const autonomyItemId = (kind: WorkKind, repo: string): string => `autonomy:${kind}:${repo}`;

/** The pair an `autonomy:` item names, or null. */
function pairOf(itemId: string): { kind: WorkKind; repo: string } | null {
  for (const kind of WORK_KINDS) {
    const head = `autonomy:${kind}:`;
    if (itemId.startsWith(head) && itemId.length > head.length) return { kind, repo: itemId.slice(head.length) };
  }
  return null;
}

/** The pair and job an `acted:<ledger id>` item names, from its `autonomy.acted` row, or null. */
function actOf(itemId: string): { kind: WorkKind; repo: string; jobId: string } | null {
  const id = Number(itemId.slice('acted:'.length));
  const e = query({ kind: 'autonomy.acted' }).find((x) => x.id === id);
  const d = e?.data as { kind?: unknown; repo?: unknown; jobId?: unknown } | undefined;
  if (!d || typeof d.kind !== 'string' || !(WORK_KINDS as readonly string[]).includes(d.kind) || typeof d.repo !== 'string' || typeof d.jobId !== 'string') return null;
  return { kind: d.kind as WorkKind, repo: d.repo, jobId: d.jobId };
}

/** The tour's stops he will see, not counting the exchange it starts and ends at. */
const realStops = (t: Tour): number => t.stops.filter((s) => s.kind !== 'exchange').length;

/** The Monday (local, YYYY-MM-DD) of the week that holds `ms`. */
function mondayOf(ms: number): string {
  const d = new Date(ms);
  const back = (d.getDay() + 6) % 7;
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - back).getTime());
}

/** The items from the ledger over the window and from the state now, in time order within their kind. */
function gather(since: string, now: number, given: BriefOptions): { drafts: Draft[]; tour: Tour | null } {
  const opts = wired(given, now);
  const drafts: Draft[] = [];
  const firmName = new Map(listFirms().map((f) => [f.id, f.name]));
  const firm = (id: string | null) => (id ? (firmName.get(id) ?? id) : null);
  const jobOf = (id: string, e?: LedgerEntry) => storedJob(id) ?? ((e?.data as { job?: Job } | undefined)?.job ?? null);

  // From the ledger: how jobs ended since his last look.
  for (const e of query({ kind: 'job.changed', from: since })) {
    const d = e.data as { id: string; from: string; to: string; job?: Job };
    const j = jobOf(d.id, e);
    const title = j?.title ?? d.id;
    const repo = j?.repo ?? null;
    if (d.to === 'merged' && d.from !== 'merged') {
      const award = query({ kind: 'job.awarded', jobId: d.id }).reverse().find((a) => (a.data as { chosen?: { firmId: string } | null }).chosen);
      const chosen = (award?.data as { chosen?: { firmId: string; price: number } } | undefined)?.chosen ?? null;
      drafts.push({
        id: `merged:${d.id}`,
        kind: 'merged',
        repo,
        title,
        text: chosen ? `Merged, and ${firm(chosen.firmId)} was paid ${num(chosen.price)} credits.` : 'Merged.',
        at: e.at,
        refs: { jobId: d.id, ...(j?.runId ? { runId: j.runId } : {}), ...(j?.floorId ? { floorId: j.floorId } : {}), ...(chosen ? { firmId: chosen.firmId } : {}) },
        actions: ['fly', 'diff', 'dismiss'],
      });
    } else if (d.to === 'failed' && d.from !== 'failed') {
      const attempts = j?.attempts ?? MAX_ATTEMPTS;
      const final = attempts >= MAX_ATTEMPTS;
      const retry = !final && j?.status === 'failed';
      drafts.push({
        id: `failed:${d.id}`,
        kind: 'failed',
        repo,
        title,
        text: `${final ? `Failed for good after ${MAX_ATTEMPTS} attempts.` : 'Failed, with one attempt left.'} ${whyFailed(d.id, e.id)}`,
        at: e.at,
        refs: { jobId: d.id, ...(j?.runId ? { runId: j.runId } : {}) },
        actions: retry ? ['retry', 'why', 'dismiss'] : ['why', 'dismiss'],
      });
    }
  }
  for (const e of query({ kind: 'merge.reverted', from: since })) {
    const d = e.data as { repo: string; jobId?: string; mergeSha?: string };
    const j = d.jobId ? storedJob(d.jobId) : null;
    drafts.push({
      id: `revert:${e.id}`,
      kind: 'revert',
      repo: d.repo,
      title: j?.title ?? 'A city merge',
      text: `A merge of "${j?.title ?? 'a city merge'}" on ${d.repo} was reverted${d.mergeSha ? ` (${d.mergeSha.slice(0, 7)})` : ''}. The market there is halted until you resume it.`,
      at: e.at,
      refs: d.jobId ? { jobId: d.jobId } : {},
      actions: ['why', 'dismiss'],
    });
  }
  for (const e of query({ kind: 'run.note', from: since })) {
    const d = e.data as { repo?: string; jobId?: string; runId?: string; note?: string; internal?: boolean; at?: string };
    if (typeof d.note !== 'string' || !d.note || d.internal === true || /^merge [0-9a-f]{7,40} (recorded for push mode|found in the history)$/.test(d.note)) continue;
    const j = d.jobId ? storedJob(d.jobId) : null;
    drafts.push({
      id: `note:${e.id}`,
      kind: 'note',
      repo: d.repo ?? j?.repo ?? null,
      title: j?.title ?? 'A note from the city',
      text: sentence(d.note),
      at: d.at ?? e.at,
      refs: { ...(d.jobId ? { jobId: d.jobId } : {}), ...(d.runId ? { runId: d.runId } : {}) },
      actions: ['why', 'dismiss'],
    });
  }
  const audits = new Map(listAudits().map((a) => [a.id, a]));
  for (const e of query({ kind: 'audit.ended', from: since })) {
    const d = e.data as { auditId: string; repo: string; status: string; audit?: Audit };
    const a = audits.get(d.auditId) ?? d.audit;
    if (!a) continue;
    drafts.push({
      id: `audit:${a.id}`,
      kind: 'audit',
      repo: a.repo,
      title: `The README audit of ${a.repo}`,
      text: auditLine(a),
      at: a.endedAt ?? e.at,
      refs: { auditId: a.id },
      actions: ['why', 'dismiss'],
    });
  }
  // Milestones: one reached in the window whose tower no longer stands is not news.
  const standing = new Set(opts.milestones().map((m) => m.id));
  for (const e of query({ kind: 'milestone.reached', from: since })) {
    const d = e.data as { milestone?: Milestone; id?: string };
    const m = d.milestone;
    if (!m?.id || !standing.has(m.id)) continue;
    // A spire passed on is the new holder's news, not the old one's.
    if (m.kind === 'skyline' && !m.lit) continue;
    drafts.push({
      id: `milestone:${m.id}`,
      kind: 'milestone',
      repo: m.repo,
      title: m.title,
      text: m.detail,
      at: m.at ?? e.at,
      refs: { milestoneId: m.id, ...(m.floorId ? { floorId: m.floorId } : {}), ...(m.firmId ? { firmId: m.firmId } : {}) },
      actions: ['fly', 'dismiss'],
    });
  }
  // From the state now: what waits on him.
  const prs = listRuns().filter((r: Run) => r.stage === 'waiting' && r.outcome === null && r.prNumber);
  for (const r of prs.sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
    const j = storedJob(r.jobId);
    drafts.push({
      id: `pr:${r.id}`,
      kind: 'pr',
      repo: r.repo,
      title: j?.title ?? r.jobId,
      text: `PR #${r.prNumber} on ${r.repo} by ${firm(r.firmId)} waits for your review.`,
      at: r.startedAt,
      refs: { jobId: r.jobId, runId: r.id, firmId: r.firmId, ...(r.prUrl ? { prUrl: redact(r.prUrl) } : {}), ...(r.inspectionId ? { inspectionId: r.inspectionId } : {}) },
      actions: ['open-pr', 'diff', 'why'],
    });
  }
  // Proposals waiting now, and the ones he already answered in this window (they keep their line, with his answer on it).
  const answered = new Set(query({ kind: 'brief.action', from: since }).map((e) => (e.data as { itemId?: string }).itemId ?? ''));
  const proposals = listJobs({ status: 'proposed' });
  for (const id of answered) if (id.startsWith('proposal:') && !proposals.some((j) => j.id === id.slice('proposal:'.length))) {
    const j = storedJob(id.slice('proposal:'.length));
    if (j) proposals.push(j);
  }
  for (const j of proposals.sort((a, b) => a.postedAt.localeCompare(b.postedAt))) {
    drafts.push({
      id: `proposal:${j.id}`,
      kind: 'proposal',
      repo: j.repo,
      title: j.title,
      text: proposalText(j),
      at: j.postedAt,
      tier: j.tier,
      refs: { jobId: j.id, ...(j.proposal ? { auditId: j.proposal.auditId } : {}) },
      actions: j.status === 'proposed' ? ['accept', 'tier', 'dismiss', 'why'] : ['why'],
    });
  }
  // Phase 4 (ruling 17): the asks for autonomy waiting on him, and the ones he answered in this window.
  const pairs = grants();
  for (const g of pairs) {
    const id = autonomyItemId(g.kind, g.repo);
    if (g.state !== 'asked' && !answered.has(id)) continue;
    const words = kindWords(g.kind);
    const n = g.rate?.n ?? 0;
    const agreed = g.rate ? Math.round(g.rate.value * n) : 0;
    drafts.push({
      id,
      kind: 'autonomy',
      repo: g.repo,
      title: `May the city ${words.verb} on ${g.repo} on its own?`,
      text: `The master has agreed with you on ${agreed} of the last ${n} ${g.kind} decisions, and on its last ${AGREE.repoLast} on ${g.repo}. If you grant it, the city acts there without you when every check holds; each act appears here, and you can revoke it at any time. Declining keeps it quiet for ${AGREE.quietDays} days.`,
      at: g.at,
      actions: g.state === 'asked' ? ['grant', 'decline', 'why'] : ['why'],
    });
  }
  // Ruling 18: what the city did on its own, one line per act, with its result when that is on record.
  const results = new Map<string, { ok: boolean; reason: string | null }>();
  const acts: Array<{ e: LedgerEntry; kind: WorkKind; repo: string; jobId: string }> = [];
  for (const e of query({ kind: 'autonomy.acted', from: since })) {
    const d = e.data as { kind?: unknown; repo?: unknown; jobId?: unknown; key?: unknown; grant?: unknown; result?: { ok?: unknown; reason?: unknown } };
    if (typeof d.kind !== 'string' || !(WORK_KINDS as readonly string[]).includes(d.kind) || typeof d.repo !== 'string' || typeof d.jobId !== 'string') continue;
    if (d.result && typeof d.result === 'object') results.set(`${d.kind}:${d.jobId}`, { ok: d.result.ok === true, reason: typeof d.result.reason === 'string' ? d.result.reason : null });
    else if (d.grant) acts.push({ e, kind: d.kind as WorkKind, repo: d.repo, jobId: d.jobId });
  }
  for (const a of acts) {
    const j = storedJob(a.jobId);
    const r = j?.runId ? listRuns({ jobId: j.id }).find((x) => x.id === j.runId) ?? null : null;
    const title = j?.title ?? a.jobId;
    const did = a.kind.startsWith('merge:') ? `merged ${r?.prNumber ? `PR #${r.prNumber} of ` : ''}"${title}"` : `accepted the proposal "${title}"`;
    const result = results.get(`${a.kind}:${a.jobId}`);
    const outcome = !result ? ' Its result is not on record yet.' : result.ok ? '' : ` It did not go through: ${sentence(result.reason ?? 'no reason was written down')}`;
    const live = pairs.find((g) => g.kind === a.kind && g.repo === a.repo)?.state === 'granted';
    drafts.push({
      id: `acted:${a.e.id}`,
      kind: 'acted',
      repo: a.repo,
      title,
      text: `The city ${did} on ${a.repo} on its own, under its ${a.kind} grant.${outcome}`,
      at: (a.e.data as { at?: string }).at ?? a.e.at,
      refs: { jobId: a.jobId, ...(r ? { runId: r.id, ...(r.prUrl ? { prUrl: redact(r.prUrl) } : {}) } : {}) },
      actions: live ? ['revoke', 'why'] : ['why'],
    });
  }
  const repos = listRepos().filter((r: Repo) => r.connected);
  for (const r of repos.filter((x) => x.halted)) {
    drafts.push({
      id: `halt:${r.fullName}`,
      kind: 'halt',
      repo: r.fullName,
      title: `${r.fullName} is halted`,
      text: `${sentence(r.halted!.reason)} The market there stays off until you resume it.`,
      at: r.halted!.at,
      actions: ['resume', 'why'],
    });
  }
  // Never audited, and worth saying: only where the market is on (an audit there would spend), and not once he
  // dismissed it, until something changes (the market turned on again, the repo connected again).
  for (const r of repos.filter((x) => x.market && latestAudit(x.fullName) === null && !auditDueDismissed(x.fullName, localDay(now)))) {
    drafts.push({
      id: `audit-due:${r.fullName}`,
      kind: 'audit-due',
      repo: r.fullName,
      title: `${r.fullName} was never audited`,
      text: 'Its README has not been checked against its code. An audit reads the clone in a sandbox and proposes jobs for what is missing; nothing runs until you accept one.',
      at: r.connectedAt ?? iso(now),
      actions: ['audit', 'dismiss'],
    });
  }

  // The windows and the reading. Today's limit is the lever on the five-hour window alone, and the line stays while his limit holds, so he can lower it again.
  const t = treasury(now);
  const near = (w: { capPct: number; usedPct: number | null; estimatedPct: number }) => Math.max(w.estimatedPct, w.usedPct ?? 0) >= w.capPct - USAGE_MARGIN;
  const daily = near(t.fiveHour) || t.todayCapPct !== null;
  if (daily || near(t.sevenDay)) {
    const w = daily ? t.fiveHour : t.sevenDay;
    const pct = num(Math.max(w.estimatedPct, w.usedPct ?? 0));
    drafts.push({
      id: 'usage',
      kind: 'usage',
      repo: null,
      title: daily ? `The five-hour window is at ${pct}%` : `The seven-day window is at ${pct}%`,
      text: daily
        ? t.todayCapPct && t.todayCapPct.pct === getSettings().dayCapPct
          ? `Today's limit is ${t.todayCapPct.pct}%, the usual cap, held by you until midnight. You can change it again here, for today only.`
          : t.todayCapPct
          ? `Today's limit is ${t.todayCapPct.pct}%, set by you, in place of the ${getSettings().dayCapPct}% cap. You can change it again here, for today only.`
          : `The cap is ${w.capPct}%. The city pauses at the cap; you can change today's limit here, for today only.`
        : `The week's hard stop is ${w.capPct}%, and every Claude call stops there. Today's limit does not move it.`,
      at: iso(now),
      actions: daily ? ['cap'] : [],
    });
  }
  // A stale reading is news only when the city has Claude work waiting on it; with every market off it waits on nothing.
  if (t.paused?.reason === 'stale' && wantsToSpend(repos)) {
    drafts.push({
      id: 'stale',
      kind: 'stale',
      repo: null,
      title: 'The usage reading is stale',
      text: `${sentence(t.paused.detail)} Claude work waits until a fresh reading arrives or you resume on the treasury page.`,
      at: iso(now),
      actions: ['why'],
    });
  }

  // The week's tour, on a Monday morning: the week that just ended.
  let tour: Tour | null = null;
  if (new Date(now).getDay() === 1) {
    const week = mondayOf(now - 7 * DAY_MS);
    tour = opts.tour(week);
    if (tour && realStops(tour) > 0) {
      drafts.push({
        id: `tour:${tour.week}`,
        kind: 'tour',
        repo: null,
        title: 'The week in the city',
        text: `A walk through last week, ${plural(realStops(tour), 'stop')} in about ${Math.round(tour.seconds)} seconds. Escape ends it.`,
        at: tour.to,
        actions: ['tour'],
      });
    }
  }
  return { drafts, tour };
}

const SECTION: Record<BriefItemKind, keyof Brief['sections']> = {
  pr: 'waiting',
  proposal: 'waiting',
  halt: 'waiting',
  merged: 'overnight',
  failed: 'overnight',
  revert: 'overnight',
  note: 'overnight',
  audit: 'overnight',
  usage: 'recommendations',
  stale: 'recommendations',
  'audit-due': 'recommendations',
  milestone: 'city',
  tour: 'city',
  // Phase 4: an ask for autonomy waits on him; an act under a grant is news from the night; a graduate is the city's.
  autonomy: 'waiting',
  acted: 'overnight',
  graduate: 'city',
};

/** The stored report data of each day, newest written last. */
function storedReports(): Map<string, ReportData> {
  const out = new Map<string, ReportData>();
  for (const e of query({ kind: 'report.written' })) {
    const d = e.data as { day: string; data?: ReportData };
    if (d.data) out.set(d.day, d.data);
  }
  return out;
}

/** The window's numbers: today's report data plus the stored reports of the earlier days in the window, never recomputed. */
function numbers(since: string, today: string): { all: number; audit: number; merged: number; failed: number } {
  // By calendar day, not by 24 hours: a day that changes the clocks is 23 or 25 hours long.
  const days: string[] = [];
  const s = new Date(Date.parse(since));
  for (let d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); localDay(d.getTime()) < today; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) days.push(localDay(d.getTime()));
  const stored = storedReports();
  const sum = { all: 0, audit: 0, merged: 0, failed: 0 };
  const add = (r: ReportData) => {
    sum.all += r.spend?.total?.all ?? 0;
    // Reports written before the audit existed have no audit total.
    sum.audit += r.spend?.total?.audit ?? 0;
    sum.merged += r.jobs?.merged?.length ?? 0;
    sum.failed += r.jobs?.failed?.length ?? 0;
  };
  for (const d of days) {
    const r = stored.get(d);
    if (r) add(r);
  }
  add(reportData(today));
  return sum;
}

/** When the window began, as the lead says it. */
function sinceWords(since: string, today: string): string {
  const day = localDay(Date.parse(since));
  if (day === today) return 'since this morning';
  const yesterday = localDay(Date.parse(`${today}T12:00:00`) - DAY_MS);
  if (day === yesterday) return 'since yesterday';
  const d = new Date(Date.parse(since));
  return `since ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()]}`;
}

/** Two sentences: what happened in the window, and what the city spent. */
function lead(items: BriefItem[], n: ReturnType<typeof numbers>, since: string, today: string): string {
  const count = (k: BriefItemKind) => items.filter((i) => i.kind === k).length;
  // The merged and failed counts are the reports' (ruling 8), never recounted from the items.
  const parts: string[] = [];
  if (n.merged) parts.push(`${n.merged} merged`);
  if (n.failed) parts.push(`${n.failed} failed`);
  if (count('pr')) parts.push(`${plural(count('pr'), 'PR')} ${count('pr') === 1 ? 'waits' : 'wait'} for your review`);
  if (count('proposal')) parts.push(`${plural(count('proposal'), 'proposal')} ${count('proposal') === 1 ? 'waits' : 'wait'} for your click`);
  if (count('halt')) parts.push(`${plural(count('halt'), 'repo')} halted`);
  const first = parts.length
    ? `${sinceWords(since, today).replace(/^s/, 'S')}: ${listOf(parts)}.`
    : items.length
      ? `Nothing merged or failed ${sinceWords(since, today)}, and ${plural(items.length, 'line')} below ${items.length === 1 ? 'waits' : 'wait'} on you.`
      : `Nothing waits on you this morning.`;
  const second = n.all > 0 ? `The city spent ${num(n.all)} credits on model calls${n.audit > 0 ? `, ${num(n.audit)} of them on README audits` : ''}.` : 'The city made no model calls.';
  return `${first} ${second}`;
}

/** Lines that stand from day to day as advice: they never open the brief before the city by themselves. */
const STANDING: ReadonlySet<BriefItemKind> = new Set(['audit-due', 'usage']);

/**
 * Whether he dismissed the repo's "never audited" line on an earlier day,
 * with nothing changed since: no market turned on and no connect after the
 * dismissal. (On the day he dismisses it, the item stays, showing it.)
 */
function auditDueDismissed(repo: string, today: string): boolean {
  const id = `audit-due:${repo}`;
  const dismissed = query({ kind: 'brief.action' })
    .filter((e) => (e.data as { itemId?: string; action?: string }).itemId === id && (e.data as { action?: string }).action === 'dismiss')
    .map((e) => e.at)
    .sort()
    .at(-1);
  if (!dismissed || localDay(Date.parse(dismissed)) >= today) return false;
  const changed = [
    ...query({ kind: 'repo.patched' }).filter((e) => {
      const d = e.data as { repo?: string; patch?: { market?: boolean } };
      return d.repo === repo && d.patch?.market === true;
    }),
    ...query({ kind: 'repo.connected' }).filter((e) => (e.data as { repo?: string }).repo === repo),
  ]
    .map((e) => e.at)
    .sort()
    .at(-1);
  return !changed || changed <= dismissed;
}

/** Whether the city has Claude work waiting: a job to bid on or under way on a market-on repo, or an audit waiting or reading. */
function wantsToSpend(repos: Repo[]): boolean {
  const on = new Set(repos.filter((r) => r.market && !r.halted).map((r) => r.fullName));
  const live = new Set(['open', 'bidding', 'awarded', 'running', 'inspecting', 'shipping']);
  if (listJobs().some((j) => on.has(j.repo) && live.has(j.status))) return true;
  return listAudits({ status: ['waiting', 'preparing', 'installing', 'reading'] }).length > 0;
}

// ---------------------------------------------------------------- triage at work (Phase 4 Task 14)

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * A trusted triage net at work on the brief, with the school on (both read
 * now, through `predict`): the recommendations ordered by its P(he acts),
 * highest first, and on each item he can still re-tier a quiet suggestion
 * of the tier it would rank highest, when that is not the item's own. It
 * never sets a tier, never moves an item between sections, and a net with
 * nothing to say for any one recommendation leaves their order as it was.
 * Nothing here can break the brief.
 */
function triage(sections: Brief['sections'], now: number): void {
  try {
    if (!getSettings().school.enabled) return;
    const all = [...sections.waiting, ...sections.overnight, ...sections.recommendations, ...sections.city];
    const position = new Map(all.map((it, i) => [it.id, i]));
    const d = new Date(now);
    const day = localDay(now);
    const shares = new Map<string, number | null>();
    const share = (repo: string | null): number | null => {
      if (!repo) return null;
      if (!shares.has(repo)) shares.set(repo, repoAcceptShare(repo, day));
      return shares.get(repo) ?? null;
    };
    const ask = (it: BriefItem, tier: Tier | null): number | null => {
      const at = Date.parse(it.at);
      const raw: RawRow = {
        kind: it.kind,
        tier,
        hours_since_at: Number.isFinite(at) ? (now - at) / 3_600_000 : null,
        weekday: WEEKDAYS[d.getDay()],
        first_open_hour: d.getHours() + d.getMinutes() / 60,
        position: position.get(it.id) ?? 0,
        repo_accept_share: share(it.repo),
      };
      return predict('triage', raw)?.p ?? null;
    };
    const recs = sections.recommendations.map((it) => ({ it, p: ask(it, it.tier) }));
    if (recs.length > 1 && recs.every((r) => r.p !== null)) {
      // a stable sort: equal odds keep their time order
      sections.recommendations = recs.sort((a, b) => (b.p as number) - (a.p as number)).map((r) => r.it);
    }
    for (const it of all) {
      if (!it.tier || it.acted || !it.actions.includes('tier')) continue;
      const odds = TIERS.map((t) => ({ t, p: ask(it, t) }));
      if (odds.some((o) => o.p === null)) continue;
      const own = odds.find((o) => o.t === it.tier)!;
      const best = odds.reduce((a, b) => ((b.p as number) > (a.p as number) ? b : a), own);
      if (best.t !== it.tier) it.suggestion = `Triage would suggest the ${best.t} tier; the tier is yours to set.`;
    }
  } catch (err) {
    console.error('palimpsest: triage could not read the brief:', err);
  }
}

/** The first `brief.opened` of today, or null. */
function openedToday(day: string): LedgerEntry | null {
  return query({ kind: 'brief.opened' }).find((e) => (e.data as { day?: string }).day === day) ?? null;
}

/** The brief as it stands now: the items of the window with his actions on them, the lead, the usage and the tour. Records nothing. */
export function briefData(now: number, opts: BriefOptions = {}): Brief {
  const day = localDay(now);
  const since = briefSince(now);
  const { drafts, tour } = gather(since, now, opts);
  const items = new Map<string, BriefItem>();
  for (const d of drafts) items.set(d.id, toItem(d));
  // His actions in the window: the newest per item.
  for (const e of query({ kind: 'brief.action', from: since })) {
    const d = e.data as { itemId?: string; action?: BriefAction; at?: string };
    const it = d.itemId ? items.get(d.itemId) : undefined;
    if (!it || !d.action) continue;
    if (covers(it.acted, d.action)) it.acted = { action: d.action, at: d.at ?? e.at };
    if (FINISHING.includes(d.action)) it.actions = it.actions.filter((a) => !FINISHING.includes(a) && a !== 'tier');
  }
  const sections: Brief['sections'] = { waiting: [], overnight: [], recommendations: [], city: [] };
  for (const it of items.values()) sections[SECTION[it.kind]].push(it);
  for (const s of Object.values(sections)) s.sort((a, b) => a.at.localeCompare(b.at));
  triage(sections, now);
  const all = [...sections.waiting, ...sections.overnight, ...sections.recommendations, ...sections.city];
  const firstOpen = openedToday(day) === null;
  const t = treasury(now);
  return {
    day,
    since,
    firstOpen,
    // The brief opens before the city only for news or what waits on him: never for a standing recommendation alone.
    due: firstOpen && all.some((it) => !STANDING.has(it.kind) && !it.acted),
    lead: plain(lead(all, numbers(since, day), since, day), 600),
    usage: { fiveHour: t.fiveHour, sevenDay: t.sevenDay, todayCapPct: t.todayCapPct?.pct ?? null, paused: t.paused ? { reason: t.paused.reason, detail: plain(t.paused.detail, 300) } : null },
    sections,
    tour: tour ? { week: tour.week, stops: realStops(tour) } : null,
  };
}

/** Every item of a brief in section order. */
export function briefItems(b: Brief): BriefItem[] {
  return [...b.sections.waiting, ...b.sections.overnight, ...b.sections.recommendations, ...b.sections.city];
}

/**
 * The brief when he opens the app: the first time each local day it records
 * `brief.opened { day, since, items }` (empty morning or not) and says
 * `firstOpen: true`; a later open the same day returns the same items and
 * records nothing more.
 */
export function openBrief(now: number, opts: BriefOptions = {}): Brief {
  const b = briefData(now, opts);
  if (b.firstOpen) {
    const items = briefItems(b).map((i) => i.id);
    record('brief.opened', { day: b.day, since: b.since, items, at: iso(now) });
    emit('brief.opened', { day: b.day, since: b.since, items });
  }
  return b;
}

/** The limit he may set for today: clamped to [5, hardStopPct - 5] (ruling 10). */
export function clampTodayCap(pct: number, hardStopPct: number): number {
  const ceiling = Math.max(5, hardStopPct - 5);
  return Math.min(ceiling, Math.max(5, Math.round(pct)));
}

/**
 * One of his actions on a brief item (ruling 9). Refuses an action the item
 * does not offer, or an item that is not in the brief, with an Error that
 * names it and writes nothing. Otherwise does the thing, records
 * `brief.action { day, itemId, kind, action, taught, at, patch }`, emits it
 * and returns the item with his action on it and what the action produced.
 */
export function actOn(itemId: string, action: BriefAction, body: { tier?: Tier; pct?: number } = {}, now: number = Date.now(), opts: BriefOptions = {}): { item: BriefItem; result: unknown } {
  const b = briefData(now, opts);
  const item = briefItems(b).find((i) => i.id === itemId);
  if (!item) throw new Error(`no brief item ${itemId}`);
  if (!item.actions.includes(action)) throw new Error(`${itemId} does not offer ${action}`);
  const patch: { tier?: Tier; pct?: number } = {};
  let result: unknown = null;
  const jobId = item.refs.jobId;
  switch (action) {
    case 'accept':
      result = acceptProposed(jobId!);
      break;
    case 'tier': {
      if (!body.tier || !TIERS.includes(body.tier)) throw new Error('tier needs one of low, normal or high');
      patch.tier = body.tier;
      result = setTier(jobId!, body.tier);
      break;
    }
    case 'dismiss':
      // A proposal is withdrawn by him and its key stays taken; any other line is only hidden.
      result = item.kind === 'proposal' ? dismissProposed(jobId!) : null;
      break;
    case 'retry':
      result = repost(jobId!);
      break;
    case 'resume':
      result = resumeRepo(item.repo!, iso(now));
      break;
    case 'cap': {
      if (typeof body.pct !== 'number' || !Number.isFinite(body.pct)) throw new Error('cap needs pct, a number');
      const pct = clampTodayCap(body.pct, getSettings().hardStopPct);
      patch.pct = pct;
      result = patchSettings({ todayCapPct: { day: b.day, pct } }).todayCapPct;
      break;
    }
    case 'audit': {
      const repo = item.repo ? getRepo(item.repo) : null;
      if (!repo) throw new Error(`no repo ${item.repo}`);
      result = queueAudit(repo, 'brief', now);
      break;
    }
    case 'grant':
    case 'decline': {
      // Only his action grants (ruling 17): from the open ask this line is.
      const pair = pairOf(itemId);
      if (!pair) throw new Error(`${itemId} names no pair`);
      result = action === 'grant' ? grant(pair.kind, pair.repo, now) : decline(pair.kind, pair.repo, now);
      break;
    }
    case 'revoke': {
      const act = actOf(itemId);
      if (!act) throw new Error(`${itemId} names no act`);
      result = revoke(act.kind, act.repo, 'him', act.jobId, now);
      break;
    }
    default:
      // why, diff, fly, open-pr and tour change nothing in the engine; the UI does the thing, and the ledger keeps that he did.
      break;
  }
  const at = iso(now);
  const taught = TAUGHT.includes(action);
  const row = { day: b.day, itemId, kind: item.kind, action, taught, at, patch };
  record('brief.action', row);
  emit('brief.action', row);
  const acted: BriefItem = { ...item, acted: covers(item.acted, action) ? { action, at } : item.acted };
  if (action === 'tier' && patch.tier) acted.tier = patch.tier;
  if (FINISHING.includes(action)) acted.actions = acted.actions.filter((a) => !FINISHING.includes(a) && a !== 'tier');
  return { item: acted, result };
}
