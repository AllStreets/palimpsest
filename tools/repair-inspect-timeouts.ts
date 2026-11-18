/**
 * A one-off repair for the runs an inspection blamed on their firm when its
 * test check only ran out of the check's time cap (before the fix that made
 * an unanswered check the engine's own failure).
 *
 * Usage, with the engine stopped and his OK:
 *
 *   npx tsx tools/repair-inspect-timeouts.ts          (a dry run: prints the plan, writes nothing)
 *   npx tsx tools/repair-inspect-timeouts.ts apply    (backs the database up, then repairs it)
 *   npx tsx tools/repair-inspect-timeouts.ts apply job-bc86195c4dba job-e096e85dbebd
 *                                                     (only the jobs named; default every such run)
 *
 * A run is repaired when it ended `failed` with "The change failed
 * inspection." and every failing check of its inspection never answered
 * (status `fail` with `inconclusive`: timed out or refused). For each one,
 * in one transaction, after a full copy of the database (`VACUUM INTO`):
 *
 * - the run ends `crashed` with the reason today's runner gives, no scar;
 * - its inspection is inconclusive, in the inspections table and in its
 *   `inspection.done` ledger rows, so reputation and the school's labels
 *   no longer read it as the firm's failure;
 * - its `run.ended` ledger rows carry the same outcome, reason and scar;
 * - its scar floor is taken off the repo's tower and its `floor.scarred`
 *   rows are deleted (reputation counts a scar as a failure);
 * - its job gets the attempt back and the firm is no longer excluded
 *   (unless the firm also failed that job on its own), recorded with a
 *   `job.changed` that keeps the job's status;
 * - the repo's strikes are counted again from its conclusive inspections;
 * - a `run.note` records what was changed and what it was before.
 *
 * The ledger is otherwise append-only; this repair amends the rows above in
 * place because reputation resolves an award on its first outcome, so an
 * appended correction could not undo it.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_ATTEMPTS, unanswered } from '../shared/market-rules.js';
import type { Inspection, Job, Run } from '../shared/types.js';
import { openDb } from '../engine/db.js';
import { paths } from '../engine/home.js';
import { record } from '../engine/ledger.js';
import { unansweredWhy } from '../engine/guild/checks.js';
import { inspectionSummary } from '../engine/guild/inspect.js';
import { enginePort } from '../engine/market/broker.js';
import { repoTowerId } from '../engine/market/ship.js';
import { getRepo, updateRepoMarket } from '../engine/repos.js';

export const FAILED_INSPECTION = 'The change failed inspection.';

export interface RunRepair {
  runId: string;
  jobId: string;
  firmId: string;
  repo: string;
  inspectionId: string;
  reason: string;
  inconclusive: string;
  scarFloorId: string;
  ledger: { inspectionDone: number[]; runEnded: number[]; floorScarred: number[] };
}

export interface JobRepair {
  jobId: string;
  status: string;
  attempts: { from: number; to: number };
  excludedFirms: { from: string[]; to: string[] };
}

export interface RepoRepair {
  repo: string;
  strikes: { from: number; to: number };
}

export interface RepairPlan {
  runs: RunRepair[];
  jobs: JobRepair[];
  repos: RepoRepair[];
}

type Row = { id: number; kind: string; json: string };

function inspectionOf(id: string): Inspection | null {
  const row = openDb().prepare('SELECT json FROM inspections WHERE id = ?').get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as Inspection) : null;
}

function ledgerRows(kind: string, runId: string): Row[] {
  return openDb().prepare('SELECT id, kind, json FROM ledger WHERE kind = ? AND run_id = ? ORDER BY id').all(kind, runId) as Row[];
}

/** The verdict today's inspection gives when only unanswered checks failed, as inspect() words it. */
export function unansweredVerdict(i: Inspection): string | null {
  const failing = i.checks.filter((c) => c.status === 'fail');
  if (i.passed || failing.length === 0 || !failing.every(unanswered)) return null;
  return failing.map((c) => `${unansweredWhy(c)}: ${c.detail}`).join(' ').slice(0, 600);
}

/** The strikes a repo holds from its conclusive inspections in ledger order: a pass clears them, a failure adds one. */
function strikesFromLedger(repo: string, skip: Set<string>): number {
  let strikes = 0;
  const rows = openDb().prepare("SELECT json FROM ledger WHERE kind = 'inspection.done' ORDER BY id").all() as Array<{ json: string }>;
  for (const { json } of rows) {
    const d = JSON.parse(json) as { repo?: string; passed?: boolean; inconclusive?: string | null; inspection?: Inspection };
    const i = d.inspection;
    if ((d.repo ?? i?.repo) !== repo) continue;
    if (i && skip.has(i.id)) continue;
    if (d.inconclusive ?? i?.inconclusive) continue;
    strikes = (d.passed ?? i?.passed) ? 0 : strikes + 1;
  }
  return strikes;
}

/** What the repair would change, read only. `jobIds` limits it to those jobs. */
export function planRepair(jobIds: string[] = []): RepairPlan {
  const db = openDb();
  const runs = (db.prepare('SELECT json FROM runs ORDER BY id').all() as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Run);
  const picked: RunRepair[] = [];
  for (const r of runs) {
    if (jobIds.length && !jobIds.includes(r.jobId)) continue;
    if (r.outcome !== 'failed' || r.endedReason !== FAILED_INSPECTION || !r.inspectionId) continue;
    const i = inspectionOf(r.inspectionId);
    const verdict = i ? unansweredVerdict(i) : null;
    if (!i || !verdict) continue;
    picked.push({
      runId: r.id,
      jobId: r.jobId,
      firmId: r.firmId,
      repo: r.repo,
      inspectionId: i.id,
      inconclusive: verdict,
      reason: `The inspection could not reach a verdict: ${verdict}`,
      scarFloorId: `${r.repo}#scar-${r.id}`,
      ledger: {
        inspectionDone: ledgerRows('inspection.done', r.id).map((x) => x.id),
        runEnded: ledgerRows('run.ended', r.id).map((x) => x.id),
        floorScarred: ledgerRows('floor.scarred', r.id).map((x) => x.id),
      },
    });
  }

  const jobs: JobRepair[] = [];
  for (const jobId of [...new Set(picked.map((p) => p.jobId))]) {
    const row = db.prepare('SELECT json FROM jobs WHERE id = ?').get(jobId) as { json: string } | undefined;
    if (!row) continue;
    const j = JSON.parse(row.json) as Job;
    const mine = picked.filter((p) => p.jobId === jobId);
    const repaired = new Set(mine.map((p) => p.runId));
    // A firm stays excluded when it also failed this job on its own (a run the repair leaves alone).
    const ownFailure = (firmId: string) => runs.some((r) => r.jobId === jobId && r.firmId === firmId && !repaired.has(r.id) && (r.outcome === 'failed' || r.outcome === 'capped'));
    const freed = new Set(mine.map((p) => p.firmId).filter((f) => !ownFailure(f)));
    jobs.push({
      jobId,
      status: j.status,
      attempts: { from: j.attempts, to: Math.max(0, j.attempts - mine.length) },
      excludedFirms: { from: j.excludedFirms, to: j.excludedFirms.filter((f) => !freed.has(f)) },
    });
  }

  const skip = new Set(picked.map((p) => p.inspectionId));
  const repos: RepoRepair[] = [];
  for (const repo of [...new Set(picked.map((p) => p.repo))]) {
    const cur = getRepo(repo);
    if (!cur) continue;
    repos.push({ repo, strikes: { from: cur.strikes, to: strikesFromLedger(repo, skip) } });
  }
  return { runs: picked, jobs, repos };
}

/** Applies `plan` in one transaction after copying the database to `backup`. Returns the backup's path. */
export function applyRepair(plan: RepairPlan, backup: string = `${paths().db}.before-inspect-timeout-repair-${Date.now()}`): string {
  const db = openDb();
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  const at = new Date().toISOString();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const p of plan.runs) {
      // The inspection: inconclusive, everywhere it is kept.
      const i = inspectionOf(p.inspectionId) as Inspection;
      const fixed: Inspection = { ...i, inconclusive: p.inconclusive };
      db.prepare('UPDATE inspections SET json = ? WHERE id = ?').run(JSON.stringify(fixed), i.id);
      for (const id of p.ledger.inspectionDone) {
        const row = db.prepare('SELECT json FROM ledger WHERE id = ?').get(id) as { json: string };
        const d = JSON.parse(row.json) as Record<string, unknown>;
        db.prepare('UPDATE ledger SET json = ? WHERE id = ?').run(JSON.stringify({ ...d, inconclusive: p.inconclusive, summary: inspectionSummary(fixed), inspection: fixed }), id);
      }
      // The run: crashed, the engine's failure, no scar.
      const runRow = db.prepare('SELECT json FROM runs WHERE id = ?').get(p.runId) as { json: string };
      const before = JSON.parse(runRow.json) as Run;
      const run: Run = { ...before, outcome: 'crashed', endedReason: p.reason, scar: false };
      db.prepare('UPDATE runs SET json = ? WHERE id = ?').run(JSON.stringify(run), p.runId);
      for (const id of p.ledger.runEnded) {
        const row = db.prepare('SELECT json FROM ledger WHERE id = ?').get(id) as { json: string };
        const d = JSON.parse(row.json) as Record<string, unknown> & { run?: Run };
        db.prepare('UPDATE ledger SET json = ? WHERE id = ?').run(JSON.stringify({ ...d, outcome: 'crashed', reason: p.reason, ...(d.run ? { run: { ...d.run, outcome: 'crashed', endedReason: p.reason, scar: false } } : {}) }), id);
      }
      // The scar: off the tower, and no longer an outcome on the ledger.
      db.prepare('DELETE FROM earned_floors WHERE id = ? AND tower_id = ?').run(p.scarFloorId, repoTowerId(p.repo));
      for (const id of p.ledger.floorScarred) db.prepare('DELETE FROM ledger WHERE id = ?').run(id);
      record('run.note', {
        runId: p.runId,
        jobId: p.jobId,
        repo: p.repo,
        note: `repaired: the inspection's test check only ran out of its time cap, so this run is the engine's failure, not ${p.firmId}'s`,
        repair: { from: { outcome: before.outcome, endedReason: before.endedReason, scar: before.scar }, inspectionId: p.inspectionId, deletedLedgerRows: p.ledger.floorScarred, amendedLedgerRows: [...p.ledger.inspectionDone, ...p.ledger.runEnded] },
        at,
      });
    }
    for (const jr of plan.jobs) {
      const row = db.prepare('SELECT json FROM jobs WHERE id = ?').get(jr.jobId) as { json: string };
      const j = JSON.parse(row.json) as Job;
      const next: Job = { ...j, attempts: jr.attempts.to, excludedFirms: jr.excludedFirms.to };
      db.prepare('UPDATE jobs SET json = ? WHERE id = ?').run(JSON.stringify(next), j.id);
      record('job.changed', { id: next.id, from: j.status, to: j.status, job: next });
    }
    for (const rr of plan.repos) updateRepoMarket(rr.repo, { strikes: rr.strikes.to });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return backup;
}

function describe(plan: RepairPlan): string {
  const lines: string[] = [];
  if (!plan.runs.length) return 'Nothing to repair: no run failed on an inspection whose only failing checks never answered.';
  for (const r of plan.runs) {
    lines.push(`run ${r.runId} (${r.firmId}, job ${r.jobId}): failed > crashed, no scar; inspection ${r.inspectionId} inconclusive`);
    lines.push(`  ledger rows amended: inspection.done ${r.ledger.inspectionDone.join(', ') || 'none'}; run.ended ${r.ledger.runEnded.join(', ') || 'none'}; deleted: floor.scarred ${r.ledger.floorScarred.join(', ') || 'none'}`);
  }
  for (const j of plan.jobs) {
    lines.push(`job ${j.jobId} (${j.status}): attempts ${j.attempts.from} > ${j.attempts.to}; excludedFirms [${j.excludedFirms.from.join(', ')}] > [${j.excludedFirms.to.join(', ')}]`);
    if (j.status === 'failed' && j.attempts.to < MAX_ATTEMPTS) lines.push('  it is failed with an attempt back: repost it from the board if it should run again');
  }
  for (const r of plan.repos) lines.push(`repo ${r.repo}: strikes ${r.strikes.from} > ${r.strikes.to}`);
  return lines.join('\n');
}

async function engineAnswers(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${enginePort()}/api/jobs`, { signal: AbortSignal.timeout(1_000) });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('apply');
  const jobIds = args.filter((a) => a.startsWith('job-'));
  const plan = planRepair(jobIds);
  console.log(describe(plan));
  if (!apply) {
    console.log('\nDry run: nothing written. Run again with apply, the engine stopped, to repair.');
    return;
  }
  if (!plan.runs.length) return;
  if (await engineAnswers()) {
    console.error(`\nRefused: the engine answers on port ${enginePort()}. Stop it first; it keeps jobs and runs in memory.`);
    process.exitCode = 1;
    return;
  }
  const backup = applyRepair(plan);
  console.log(`\nRepaired. The database before the repair is at ${backup}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
