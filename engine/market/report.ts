/**
 * The daily report (spec 8, Task 18): one Markdown page a day under
 * `paths().reports/<day>.md`, written from the ledger (read through its
 * kind and time indexes) and the credits rows, and recorded as
 * `report.written` with its data. It says what the market did that day and
 * what waits on him. Plain prose and small tables in sentence case: no
 * dashes as punctuation, no emojis, no rhetoric.
 */
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { CREDIT_PCT } from '../../shared/credits.js';
import { MAX_ATTEMPTS } from '../../shared/market-rules.js';
import type { Bid, Job } from '../../shared/types.js';
import { openDb } from '../db.js';
import { emit } from '../events.js';
import { paths } from '../home.js';
import { query, record, type LedgerEntry } from '../ledger.js';
import { listRepos } from '../repos.js';
import { getSettings } from '../settings.js';
import { storedCalibration } from '../usage.js';
import { listAgents, listFirms } from './firms.js';
import { job as storedJob, listJobs } from './jobs.js';
import { listRuns, run as storedRun } from './runs.js';

export interface ReportJob {
  id: string;
  repo: string;
  title: string;
}

export interface ReportData {
  day: string;
  from: string;
  to: string;
  jobs: {
    posted: ReportJob[];
    awarded: Array<ReportJob & { firmId: string; agentId: string; price: number }>;
    merged: Array<ReportJob & { firmId: string | null; price: number | null }>;
    failed: Array<ReportJob & { why: string; final: boolean }>;
    closed: ReportJob[];
  };
  spend: {
    /** Model calls charged to firms (bids and runs) and what each was paid, in credits. */
    firms: Array<{ firmId: string; name: string; bids: number; runs: number; paid: number; balance: number }>;
    /** Every model call the city paid for, by model, in credits; Claude calls also as a share of a five-hour window. */
    models: Array<{ model: string; credits: number; windowPct: number | null; usd: number }>;
    total: { bid: number; run: number; review: number; judge: number; all: number };
    paid: { pay: number; reviewPay: number };
    received: { hire: number; sale: number };
    caps: { dayCapPct: number; dayCapCredits: number; nightCapPct: number };
    claudeCredits: number;
  };
  calibration: { tokensPerPct: number; measured: boolean; samples: number };
  api: { usd: number; dailyUsd: number; enabled: boolean } | null;
  halts: Array<{ repo: string; reason: string; at: string }>;
  resumes: Array<{ repo: string; at: string }>;
  reverts: Array<{ repo: string; jobId: string | null; title: string; mergeSha: string | null }>;
  bankruptcies: Array<{ firmId: string; name: string }>;
  sales: Array<{ agentId: string; from: string; to: string; price: number }>;
  hires: Array<{ agentId: string; name: string; firmId: string }>;
  waiting: {
    prs: Array<ReportJob & { number: number; url: string | null; firmId: string; since: string }>;
    proposed: ReportJob[];
    haltedRepos: Array<{ repo: string; reason: string; at: string }>;
    haltedJobs: Array<ReportJob & { note: string }>;
    notes: Array<{ repo: string | null; jobId: string | null; runId: string | null; title: string | null; note: string; at: string }>;
  };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The local day's bounds as ISO times (the ledger's `at` is ISO in UTC). */
function bounds(day: string): { start: Date; from: string; to: string } {
  const m = DAY.exec(day);
  if (!m) throw new Error(`not a day: ${day}`);
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const end = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1);
  return { start, from: start.toISOString(), to: end.toISOString() };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
/** 1234.5 as "1,234.5", at most two decimals. */
const num = (n: number) => round2(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
const usd = (n: number) => `$${round2(n).toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A cell or line of text from outside (an issue title, a model's note): one line, no table breaks. */
function clean(s: string, max = 240): string {
  const one = s.replace(/\s+/g, ' ').replace(/\|/g, '/').trim();
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}

/** Text ending as a sentence does. */
function sentence(s: string): string {
  const t = s.trim();
  return !t || /[.!?)]$/.test(t) ? t : `${t}.`;
}

function listOf(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function jobRef(j: Pick<Job, 'id' | 'repo' | 'title'> | null, id: string): ReportJob {
  return { id, repo: j?.repo ?? '', title: j?.title ?? id };
}

/** Gathers the day's data. */
export function reportData(day: string): ReportData {
  const { from, to } = bounds(day);
  const inDay = (kinds: Parameters<typeof query>[0]['kind']) => query({ kind: kinds, from, to });
  const firms = listFirms();
  const firmName = new Map(firms.map((f) => [f.id, f.name]));
  const agentName = new Map(listAgents().map((a) => [a.id, a.name]));
  const jobOf = (id: string, e?: LedgerEntry) => storedJob(id) ?? ((e?.data as { job?: Job } | undefined)?.job ?? null);

  // Jobs.
  const posted = inDay('job.posted').map((e) => {
    const j = (e.data as { job: Job }).job;
    return jobRef(j, j.id);
  });
  const awarded: ReportData['jobs']['awarded'] = [];
  for (const e of inDay('job.awarded')) {
    const d = e.data as { jobId: string; chosen: Bid | null };
    if (!d.chosen) continue;
    awarded.push({ ...jobRef(jobOf(d.jobId), d.jobId), firmId: d.chosen.firmId, agentId: d.chosen.agentId, price: d.chosen.price });
  }
  const merged: ReportData['jobs']['merged'] = [];
  const failed: ReportData['jobs']['failed'] = [];
  const closed: ReportJob[] = [];
  for (const e of inDay('job.changed')) {
    const d = e.data as { id: string; to: string; job?: Job };
    const j = d.job ?? jobOf(d.id);
    if (d.to === 'merged') {
      const award = query({ kind: 'job.awarded', jobId: d.id }).reverse().find((a) => (a.data as { chosen?: Bid | null }).chosen);
      const chosen = (award?.data as { chosen?: Bid } | undefined)?.chosen ?? null;
      merged.push({ ...jobRef(j, d.id), firmId: chosen?.firmId ?? null, price: chosen?.price ?? null });
    } else if (d.to === 'failed') {
      failed.push({ ...jobRef(j, d.id), why: whyFailed(d.id, e.id), final: (j?.attempts ?? 0) >= MAX_ATTEMPTS });
    } else if (d.to === 'closed') {
      closed.push(jobRef(j, d.id));
    }
  }

  // Credits: every row of the day.
  const rows = openDb().prepare('SELECT firm_id, kind, amount, usd, json FROM credits WHERE at >= ? AND at < ?').all(from, to) as Array<{ firm_id: string | null; kind: string; amount: number; usd: number | null; json: string }>;
  const total = { bid: 0, run: 0, review: 0, judge: 0, all: 0 };
  const paid = { pay: 0, reviewPay: 0 };
  const received = { hire: 0, sale: 0 };
  const byFirm = new Map<string, { bids: number; runs: number; paid: number }>();
  const byModel = new Map<string, { credits: number; claude: boolean; usd: number }>();
  let apiUsd = 0;
  const firmRow = (id: string) => byFirm.get(id) ?? byFirm.set(id, { bids: 0, runs: 0, paid: 0 }).get(id)!;
  for (const r of rows) {
    const meta = (() => {
      try {
        return JSON.parse(r.json) as { model?: string; pool?: string };
      } catch {
        return {};
      }
    })();
    if (r.kind === 'bid' || r.kind === 'run' || r.kind === 'review' || r.kind === 'judge') {
      total[r.kind] += r.amount;
      total.all += r.amount;
      const model = meta.model ?? 'unknown';
      const m = byModel.get(model) ?? { credits: 0, claude: meta.pool === 'claude', usd: 0 };
      m.credits += r.amount;
      m.usd += r.usd ?? 0;
      byModel.set(model, m);
      apiUsd += r.usd ?? 0;
      if (r.firm_id && (r.kind === 'bid' || r.kind === 'run')) {
        const f = firmRow(r.firm_id);
        if (r.kind === 'bid') f.bids += r.amount;
        else f.runs += r.amount;
      }
    } else if (r.kind === 'pay' || r.kind === 'review-pay') {
      if (r.kind === 'pay') paid.pay += r.amount;
      else paid.reviewPay += r.amount;
      if (r.firm_id) firmRow(r.firm_id).paid += r.amount;
    } else if (r.kind === 'hire') received.hire += r.amount;
    else if (r.kind === 'sale') received.sale += r.amount;
  }
  const settings = getSettings();
  const claudeCredits = [...byModel.values()].filter((m) => m.claude).reduce((s, m) => s + m.credits, 0);
  const cal = storedCalibration();

  // Halts, reverts, firms.
  const halts = inDay('repo.halted').map((e) => {
    const d = e.data as { repo: string; reason: string; at?: string };
    return { repo: d.repo, reason: d.reason, at: d.at ?? e.at };
  });
  const resumes = inDay('repo.resumed').map((e) => ({ repo: (e.data as { repo: string }).repo, at: e.at }));
  const reverts = inDay('merge.reverted').map((e) => {
    const d = e.data as { repo: string; jobId?: string; mergeSha?: string };
    return { repo: d.repo, jobId: d.jobId ?? null, title: d.jobId ? (storedJob(d.jobId)?.title ?? d.jobId) : 'a city merge', mergeSha: d.mergeSha ?? null };
  });
  const bankruptcies = inDay('firm.bankrupt').map((e) => {
    const id = (e.data as { firmId: string }).firmId;
    return { firmId: id, name: firmName.get(id) ?? id };
  });
  const sales = inDay('tower.sold').map((e) => {
    const d = e.data as { agentId: string; from: string; to: string; price: number };
    return { agentId: d.agentId, from: d.from, to: d.to, price: d.price };
  });
  const hires = inDay('agent.hired').map((e) => {
    const a = (e.data as { agent: { id: string; name: string; firmId: string } }).agent;
    return { agentId: a.id, name: a.name, firmId: a.firmId };
  });

  // What waits on him: the state now, and the day's notes for him.
  const prs = listRuns()
    .filter((r) => r.stage === 'waiting' && r.outcome === null && r.prNumber)
    .map((r) => ({ ...jobRef(storedJob(r.jobId), r.jobId), repo: r.repo, number: r.prNumber as number, url: r.prUrl, firmId: r.firmId, since: r.startedAt }))
    .sort((a, b) => a.since.localeCompare(b.since));
  const proposed = listJobs({ status: 'proposed' }).map((j) => jobRef(j, j.id));
  const haltedRepos = listRepos()
    .filter((r) => r.halted)
    .map((r) => ({ repo: r.fullName, reason: r.halted!.reason, at: r.halted!.at }));
  const haltedJobs = listJobs({ status: 'halted' })
    .filter((j) => j.haltNote)
    .map((j) => ({ ...jobRef(j, j.id), note: j.haltNote as string }));
  const notes = inDay('run.note')
    .map((e) => ({ e, d: e.data as { repo?: string; jobId?: string; runId?: string; note?: string; internal?: boolean; at?: string } }))
    .filter(({ d }) => typeof d.note === 'string' && d.note && !isBookkeeping(d))
    .map(({ e, d }) => {
      // A note that names only its run (a refused login refresh) is placed by the run.
      const r = d.runId && (!d.repo || !d.jobId) ? storedRun(d.runId) : null;
      const jobId = d.jobId ?? r?.jobId ?? null;
      return { repo: d.repo ?? r?.repo ?? null, jobId, runId: d.runId ?? null, title: jobId ? (storedJob(jobId)?.title ?? null) : null, note: d.note as string, at: d.at ?? e.at };
    });

  return {
    day,
    from,
    to,
    jobs: { posted, awarded, merged, failed, closed },
    spend: {
      firms: [...byFirm.entries()]
        .map(([firmId, f]) => ({ firmId, name: firmName.get(firmId) ?? firmId, bids: round2(f.bids), runs: round2(f.runs), paid: round2(f.paid), balance: round2(firms.find((x) => x.id === firmId)?.balance ?? 0) }))
        .sort((a, b) => b.bids + b.runs - (a.bids + a.runs) || a.name.localeCompare(b.name)),
      models: [...byModel.entries()]
        .map(([model, m]) => ({ model, credits: round2(m.credits), windowPct: m.claude ? round2(m.credits * CREDIT_PCT) : null, usd: round2(m.usd) }))
        .sort((a, b) => b.credits - a.credits || a.model.localeCompare(b.model)),
      total: { bid: round2(total.bid), run: round2(total.run), review: round2(total.review), judge: round2(total.judge), all: round2(total.all) },
      paid: { pay: round2(paid.pay), reviewPay: round2(paid.reviewPay) },
      received: { hire: round2(received.hire), sale: round2(received.sale) },
      caps: { dayCapPct: settings.dayCapPct, dayCapCredits: round2(settings.dayCapPct / CREDIT_PCT), nightCapPct: settings.nightCapPct },
      claudeCredits: round2(claudeCredits),
    },
    calibration: { tokensPerPct: Math.round(cal.value), measured: cal.samples > 0, samples: cal.samples },
    api: apiUsd > 0 || settings.anthropicApi.enabled ? { usd: round2(apiUsd), dailyUsd: settings.anthropicApi.dailyUsd, enabled: settings.anthropicApi.enabled } : null,
    halts,
    resumes,
    reverts,
    bankruptcies,
    sales,
    hires,
    waiting: { prs, proposed, haltedRepos, haltedJobs, notes },
  };
}

/** A note the city keeps for replay (a merge sha it found), not one for his brief. */
function isBookkeeping(d: { note?: string; internal?: boolean }): boolean {
  return d.internal === true || /^merge [0-9a-f]{7,40} (recorded for push mode|found in the history)$/.test(d.note ?? '');
}

/** Why a job failed: the run's end reason, and the inspection's summary when the change failed it. */
function whyFailed(jobId: string, beforeId: number): string {
  const ended = query({ kind: 'run.ended', jobId }).filter((e) => e.id < beforeId).at(-1);
  if (!ended) return 'No run on record says why.';
  const d = ended.data as { runId?: string; reason?: string | null; outcome?: string };
  let why = d.reason ? d.reason.trim() : `The run ended ${d.outcome ?? 'without a reason'}.`;
  if (!/[.!?]$/.test(why)) why += '.';
  if (d.runId) {
    const insp = query({ kind: 'inspection.done', runId: d.runId }).at(-1);
    const summary = (insp?.data as { summary?: string; passed?: boolean } | undefined);
    if (summary && summary.passed === false && summary.summary) why += ` ${summary.summary.trim()}`;
  }
  return why;
}

// ---------------------------------------------------------------- the page

function longDay(day: string): string {
  const { start } = bounds(day);
  return `${WEEKDAYS[start.getDay()]} ${start.getDate()} ${MONTHS[start.getMonth()]} ${start.getFullYear()}`;
}

function table(head: string[], body: string[][]): string[] {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => ':-').join('|')}|`, ...body.map((r) => `| ${r.join(' | ')} |`)];
}

/** The page he reads, from the day's data. */
export function renderReport(r: ReportData, names: { firm: (id: string) => string; agent: (id: string) => string }): string {
  const out: string[] = [];
  const { jobs, spend, waiting } = r;
  const firm = names.firm;
  out.push(`# Palimpsest, ${longDay(r.day)}`, '');

  // The lead: the day in two sentences.
  const counts = [
    plural(jobs.posted.length, 'job') + ' posted',
    `${jobs.awarded.length} awarded`,
    `${jobs.merged.length} merged`,
    `${jobs.failed.length} failed`,
  ];
  const lead = jobs.posted.length + jobs.awarded.length + jobs.merged.length + jobs.failed.length === 0
    ? 'No jobs were posted, awarded, merged or failed today.'
    : `Today: ${listOf(counts)}.`;
  const spent = spend.total.all > 0 ? ` The city spent ${num(spend.total.all)} credits on model calls and paid firms ${num(spend.paid.pay + spend.paid.reviewPay)}.` : ' The city made no model calls.';
  out.push(lead + spent, '');

  // What waits on him first: it is the part he acts on.
  out.push('## Waiting on you', '');
  const waits: string[] = [];
  for (const p of waiting.prs) waits.push(`- PR #${p.number} on ${p.repo}, "${clean(p.title)}" by ${firm(p.firmId)}, waits for your review${p.url ? ` (${p.url})` : ''}.`);
  for (const j of waiting.proposed) waits.push(`- A proposed job on ${j.repo}, "${clean(j.title)}". Nothing bids on it until you accept it on the job board or the district page.`);
  for (const h of waiting.haltedRepos) waits.push(`- ${h.repo} is halted: ${sentence(clean(h.reason))} The market there stays off until you resume it.`);
  for (const j of waiting.haltedJobs) waits.push(`- "${clean(j.title)}" on ${j.repo} is halted: ${sentence(clean(j.note))}`);
  for (const n of waiting.notes) waits.push(`- ${[n.repo, n.title ? `"${clean(n.title)}"` : null].filter(Boolean).join(', ')}${n.repo || n.title ? ': ' : ''}${sentence(clean(n.note, 400))}`);
  out.push(...(waits.length ? waits : ['Nothing waits on you.']), '');

  // Jobs.
  out.push('## Jobs', '');
  // One row per job, its day in order: posted, awarded, then how it ended.
  const rowsByJob = new Map<string, { title: string; repo: string; parts: string[] }>();
  const add = (j: ReportJob, part: string) => {
    const row = rowsByJob.get(j.id) ?? rowsByJob.set(j.id, { title: j.title, repo: j.repo, parts: [] }).get(j.id)!;
    row.parts.push(part);
  };
  for (const j of jobs.posted) add(j, 'Posted.');
  for (const j of jobs.awarded) add(j, `Awarded to ${names.agent(j.agentId)} of ${firm(j.firmId)} at ${num(j.price)} credits.`);
  for (const j of jobs.merged) add(j, j.firmId ? `Merged, and ${firm(j.firmId)} was paid${j.price !== null ? ` ${num(j.price)} credits` : ''}.` : 'Merged.');
  for (const j of jobs.failed) add(j, `${j.final ? `Failed for good after ${MAX_ATTEMPTS} attempts.` : 'Failed, with one attempt left.'} ${sentence(clean(j.why, 400))}`);
  for (const j of jobs.closed) add(j, 'Closed with no merge the city is paid for.');
  const lines = [...rowsByJob.values()].map((x) => [clean(x.title), x.repo, x.parts.join(' ')]);
  if (lines.length) out.push(...table(['Job', 'Repo', 'What happened'], lines), '');
  else out.push('No jobs were posted, awarded, merged, failed or closed today.', '');

  // Credits.
  out.push('## Credits', '');
  if (spend.total.all > 0) {
    const parts = [`${num(spend.total.bid)} on bids`, `${num(spend.total.run)} on runs`];
    if (spend.total.review + spend.total.judge > 0) parts.push(`${num(spend.total.review + spend.total.judge)} on reviews and design checks`);
    const pay = [spend.paid.pay > 0 ? `${num(spend.paid.pay)} for merges` : '', spend.paid.reviewPay > 0 ? `${num(spend.paid.reviewPay)} for reviews` : ''].filter(Boolean);
    out.push(`Model calls cost ${num(spend.total.all)} credits: ${listOf(parts)}.${pay.length ? ` The city paid firms ${listOf(pay)}.` : ''}`, '');
  } else {
    out.push('No model calls were charged today.', '');
  }
  if (spend.firms.length) {
    out.push(...table(['Firm', 'Bids', 'Runs', 'Paid', 'Balance now'], spend.firms.map((f) => [f.name, num(f.bids), num(f.runs), num(f.paid), num(f.balance)])), '');
  }
  if (spend.models.length) {
    out.push(...table(['Model', 'Credits', 'Share of a five-hour window'], spend.models.map((m) => [m.model, num(m.credits), m.windowPct === null ? (m.usd > 0 ? `API, ${usd(m.usd)}` : 'local') : `${num(m.windowPct)}%`])), '');
  }
  const c = spend.caps;
  out.push(
    `The cap is ${c.dayCapPct}% of each five-hour window, ${num(c.dayCapCredits)} credits a window, and ${c.nightCapPct}% of the week at night. Claude calls today came to ${num(spend.claudeCredits)} credits, ${num(spend.claudeCredits * CREDIT_PCT)}% of one window.`,
    '',
  );
  out.push(
    r.calibration.measured
      ? `1% of the five-hour window is about ${num(r.calibration.tokensPerPct)} weighted tokens, measured from ${plural(r.calibration.samples, 'pair')} of readings.`
      : `1% of the five-hour window is assumed to be ${num(r.calibration.tokensPerPct)} weighted tokens until two readings measure it.`,
    '',
  );
  if (r.api) {
    out.push(r.api.usd > 0 ? `The Anthropic API cost ${usd(r.api.usd)} today, against a daily limit of ${usd(r.api.dailyUsd)}.` : `The Anthropic API is on and cost nothing today.`, '');
  }

  // Halts and reverts.
  out.push('## Halts and reverts', '');
  const hr: string[] = [];
  for (const v of r.reverts) hr.push(`- A merge of "${clean(v.title)}" on ${v.repo} was reverted${v.mergeSha ? ` (${v.mergeSha.slice(0, 7)})` : ''}.`);
  for (const h of r.halts) hr.push(`- ${h.repo} was halted: ${sentence(clean(h.reason))}`);
  for (const h of r.resumes) hr.push(`- ${h.repo} was resumed.`);
  out.push(...(hr.length ? hr : ['No repo was halted and no merge was reverted.']), '');

  // Firms.
  out.push('## Firms', '');
  const fs: string[] = [];
  for (const b of r.bankruptcies) fs.push(`- ${b.name} went bankrupt. Its towers stand dark until another firm buys them.`);
  for (const s of r.sales) fs.push(`- ${firm(s.to)} bought the dark tower of ${names.agent(s.agentId)} from ${firm(s.from)} for ${num(s.price)} credits.`);
  for (const h of r.hires) fs.push(`- ${firm(h.firmId)} hired ${h.name}.`);
  out.push(...(fs.length ? fs : ['No firm went bankrupt, sold a tower or hired today.']), '');

  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * Writes the report for `day` (local, YYYY-MM-DD) to `paths().reports/<day>.md`,
 * records `report.written` with the path and the data, and returns the Markdown.
 * Writing a day again replaces its page and records it again.
 */
export function writeDailyReport(day: string): string {
  const data = reportData(day);
  const firmNames = new Map(listFirms().map((f) => [f.id, f.name]));
  const agentNames = new Map(listAgents().map((a) => [a.id, a.name]));
  const markdown = renderReport(data, { firm: (id) => firmNames.get(id) ?? id, agent: (id) => agentNames.get(id) ?? id });
  const path = join(paths().reports, `${day}.md`);
  writeFileSync(path, markdown);
  const at = new Date().toISOString();
  record('report.written', { day, path, at, data });
  emit('report.written', { day, path });
  return markdown;
}

/** The newest report written: its day, its page and its data. Null before the first. */
export function latestReport(): { day: string; markdown: string; data: ReportData } | null {
  const [e] = query({ kind: 'report.written', last: true });
  if (!e) return null;
  const d = e.data as { day: string; path?: string; data: ReportData };
  const path = d.path ?? join(paths().reports, `${d.day}.md`);
  const markdown = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return { day: d.day, markdown, data: d.data };
}
