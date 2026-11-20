/**
 * A one-time restatement of the firms' books (the economy change of Nov 19):
 * the last 7 days of spend charged again as if cooling off (A), the local
 * plan floor (B) and the refund of runs the engine ended (C) had held all
 * week, by the proposal's method. The difference for each firm is booked as
 * one `correction` credits row and its `credits.moved`, from the city; a
 * firm still below zero after it starts its 72 hours again from now.
 *
 * Usage, with the engine stopped:
 *
 *   npx tsx tools/restate-economy.ts            (a dry run: prints the table, writes nothing)
 *   npx tsx tools/restate-economy.ts --dry-run  (the same)
 *   npx tsx tools/restate-economy.ts --apply    (backs the database up, then books the corrections)
 *
 * It reads PALIMPSEST_HOME for the data home and PALIMPSEST_PORT for the
 * engine's port, and refuses to run while anything answers on that port.
 * It runs once: a second --apply finds the first one's corrections and
 * refuses.
 *
 * The method, as the proposal's:
 * - A: each job's rounds in the window (its `job.awarded` entries, by their
 *   own time), oldest first. A round that awarded nothing before the wait
 *   the rule would have set had passed did not happen; one that did
 *   happen counts one more empty round in a row (an award, his edit or a
 *   retry starts the count again), and sets the next wait, 10 min x 2^(k-1)
 *   up to a day.
 * - Each bid in the window (`bids` rows with a bid; a sit-out carries no
 *   cost on its row and is left as it was) belongs to the round of its job
 *   nearest its round's close, within 15 minutes; a bid in a round that
 *   did not happen costs nothing.
 * - B: a bid by an agent on a local model (`ollama:`, `mlx:`) charged at the
 *   old floor of 3 a call costs LOCAL_PLAN_FLOOR a call instead (its calls
 *   from its `bid.placed`, else its cost over 3).
 * - C: every run in the window that ended crashed or killed with no scar,
 *   and was not refunded yet, gives back its run charges.
 */
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { coolOffMs, creditsFixed } from '../shared/market-rules.js';
import type { ModelRef, Run } from '../shared/types.js';
import { openDb } from '../engine/db.js';
import { home, paths } from '../engine/home.js';
import { enginePort } from '../engine/market/broker.js';
import { LOCAL_PLAN_FLOOR, PLAN_ESTIMATE } from '../engine/market/budget.js';
import { listFirms } from '../engine/market/firms.js';
import { balances, bookCorrection, engineFault, refunded, restartNegativeClock } from '../engine/market/treasury.js';

/** How far back the restatement reaches. */
export const WINDOW_DAYS = 7;
/** How far a bid's round may sit from the award that closed it and still be that round's. */
const ROUND_MATCH_MS = 15 * 60_000;
const MICRO = 1_000_000;
const micro = (x: number): number => Math.round(x * MICRO);
const credits = (m: number): number => m / MICRO;

export interface FirmRestatement {
  firmId: string;
  name: string;
  /** The balance now. */
  before: number;
  /** What the window's bids cost, and what they cost restated. */
  bids: { was: number; restated: number };
  /** The run charges given back. */
  refunds: number;
  /** The runs whose charges are given back. */
  refundedRuns: string[];
  /** restated difference: (bids.was - bids.restated) + refunds. */
  correction: number;
  after: number;
}

export interface Restatement {
  from: string;
  to: string;
  rounds: { was: number; kept: number };
  firms: FirmRestatement[];
  /** Set when a restatement is already on the books: nothing may be applied again. */
  alreadyApplied: boolean;
}

const isLocal = (model: string): boolean => model.startsWith('ollama:') || model.startsWith('mlx:');

/** Each job's rounds in the window, oldest first: when it closed, whether it awarded, whether it would have happened under A. */
function roundsByJob(from: string, to: string): Map<string, Array<{ t: number; awarded: boolean; kept: boolean }>> {
  const rows = openDb()
    .prepare(
      `SELECT id, kind, job_id AS jobId, json_extract(json, '$.at') AS at, json_extract(json, '$.chosen.id') AS chosen,
              json_extract(json, '$.from') AS f, json_extract(json, '$.to') AS t, ledger.at AS ledgerAt
       FROM ledger WHERE kind IN ('job.awarded', 'job.changed') AND job_id IS NOT NULL ORDER BY id`,
    )
    .all() as Array<{ id: number; kind: string; jobId: string; at: string | null; chosen: string | null; f: string | null; t: string | null; ledgerAt: string }>;
  const events = new Map<string, Array<{ kind: 'round' | 'reset'; t: number; awarded: boolean }>>();
  for (const r of rows) {
    const at = r.kind === 'job.awarded' ? (r.at ?? r.ledgerAt) : r.ledgerAt;
    if (at < from || at >= to) continue;
    const list = events.get(r.jobId) ?? [];
    if (r.kind === 'job.awarded') list.push({ kind: 'round', t: Date.parse(at), awarded: r.chosen !== null });
    else if (r.f === r.t || (r.f === 'failed' && r.t === 'open')) list.push({ kind: 'reset', t: Date.parse(at), awarded: false });
    else continue;
    events.set(r.jobId, list);
  }
  const out = new Map<string, Array<{ t: number; awarded: boolean; kept: boolean }>>();
  for (const [jobId, list] of events) {
    list.sort((a, b) => a.t - b.t);
    let k = 0;
    let allowed = 0;
    const rounds: Array<{ t: number; awarded: boolean; kept: boolean }> = [];
    for (const e of list) {
      if (e.kind === 'reset') {
        k = 0;
        allowed = 0;
        continue;
      }
      if (!e.awarded && e.t < allowed) {
        rounds.push({ t: e.t, awarded: false, kept: false });
        continue;
      }
      rounds.push({ t: e.t, awarded: e.awarded, kept: true });
      if (e.awarded) {
        k = 0;
        allowed = 0;
      } else {
        k += 1;
        allowed = e.t + coolOffMs(k);
      }
    }
    out.set(jobId, rounds);
  }
  return out;
}

/** What the restatement would book, read only. */
export function planRestatement(now: number = Date.now()): Restatement {
  const db = openDb();
  const to = new Date(now).toISOString();
  const from = new Date(now - WINDOW_DAYS * 24 * 3_600_000).toISOString();
  const alreadyApplied = Boolean(db.prepare("SELECT 1 FROM credits WHERE kind = 'correction' AND json_extract(json, '$.reason') = 'restatement' LIMIT 1").get());

  const rounds = roundsByJob(from, to);
  const models = new Map((db.prepare('SELECT id, json FROM agents').all() as Array<{ id: string; json: string }>).map((r) => [r.id, (JSON.parse(r.json) as { model: ModelRef }).model]));
  const calls = new Map<string, number>();
  for (const r of db.prepare("SELECT json_extract(json, '$.bid.id') AS id, json_extract(json, '$.calls') AS calls FROM ledger WHERE kind = 'bid.placed'").all() as Array<{ id: string | null; calls: number | null }>) {
    if (r.id && typeof r.calls === 'number' && r.calls > 0) calls.set(r.id, r.calls);
  }

  const was = new Map<string, number>();
  const restated = new Map<string, number>();
  for (const row of db.prepare('SELECT job_id AS jobId, json FROM bids').all() as Array<{ jobId: string; json: string }>) {
    const d = JSON.parse(row.json) as { round?: string; bid?: { id: string; firmId: string; agentId: string; cost?: number; at: string } };
    const b = d.bid;
    if (!b?.firmId || typeof b.at !== 'string' || b.at < from || b.at >= to) continue;
    const cost = typeof b.cost === 'number' && Number.isFinite(b.cost) ? b.cost : 0;
    was.set(b.firmId, (was.get(b.firmId) ?? 0) + micro(cost));
    // A: the round this bid was in, by the nearest close within the match; a round that would not have happened costs nothing.
    const close = Date.parse(d.round ?? '');
    const nearest = (rounds.get(row.jobId) ?? []).reduce<{ t: number; kept: boolean } | null>((best, r) => (!best || Math.abs(r.t - close) < Math.abs(best.t - close) ? r : best), null);
    const kept = !nearest || !Number.isFinite(close) || Math.abs(nearest.t - close) > ROUND_MATCH_MS || nearest.kept;
    if (!kept) continue;
    // B: a local plan call charged at the old floor pays the local floor instead.
    let next = cost;
    if (isLocal(models.get(b.agentId) ?? '')) {
      const n = calls.get(b.id) ?? Math.round(cost / PLAN_ESTIMATE);
      if (n > 0 && cost >= n * PLAN_ESTIMATE - 1e-9) next = n * LOCAL_PLAN_FLOOR + (cost - n * PLAN_ESTIMATE);
    }
    restated.set(b.firmId, (restated.get(b.firmId) ?? 0) + micro(next));
  }

  // C: the run charges of runs the engine ended, not yet given back.
  const refunds = new Map<string, number>();
  const refundedRuns = new Map<string, string[]>();
  for (const { json } of db.prepare('SELECT json FROM runs').all() as Array<{ json: string }>) {
    const r = JSON.parse(json) as Run;
    if (!r.endedAt || r.endedAt < from || r.endedAt >= to || !engineFault(r) || refunded(r.id)) continue;
    const row = db.prepare("SELECT COALESCE(SUM(CAST(ROUND(amount * 1000000) AS INTEGER)), 0) AS m FROM credits WHERE run_id = ? AND firm_id = ? AND kind = 'run'").get(r.id, r.firmId) as { m: number | bigint };
    const m = Number(row.m);
    if (m <= 0) continue;
    refunds.set(r.firmId, (refunds.get(r.firmId) ?? 0) + m);
    refundedRuns.set(r.firmId, [...(refundedRuns.get(r.firmId) ?? []), r.id]);
  }

  const bal = balances();
  const firms: FirmRestatement[] = listFirms().map((f) => {
    const w = was.get(f.id) ?? 0;
    const n = restated.get(f.id) ?? 0;
    const back = refunds.get(f.id) ?? 0;
    // Once restated, nothing more is owed: the table shows the books as they stand.
    const correction = alreadyApplied ? 0 : w - n + back;
    const before = micro(bal[f.id] ?? f.balance);
    return {
      firmId: f.id,
      name: f.name,
      before: credits(before),
      bids: { was: credits(w), restated: credits(n) },
      refunds: credits(back),
      refundedRuns: refundedRuns.get(f.id) ?? [],
      correction: credits(correction),
      after: credits(before + correction),
    };
  });
  let total = 0;
  let kept = 0;
  for (const list of rounds.values()) {
    total += list.length;
    kept += list.filter((r) => r.kept).length;
  }
  return { from, to, rounds: { was: total, kept }, firms, alreadyApplied };
}

/**
 * Books the plan's corrections, after a full copy of the database to
 * `backup`, in one transaction: one `correction` per firm with anything to
 * give back, and a firm still below zero starts its 72 hours again from
 * `now`. Returns the backup's path. Throws, writing nothing, when a
 * restatement is already on the books.
 */
export function applyRestatement(plan: Restatement, now: number = Date.now(), backup: string = `${paths().db}.before-restatement-${now}`): string {
  if (plan.alreadyApplied || planRestatement(now).alreadyApplied) throw new Error('the books were already restated once; nothing was written');
  const db = openDb();
  db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const f of plan.firms) {
      const restartClock = f.after < 0;
      if (f.correction > 0) {
        bookCorrection(f.firmId, f.correction, { reason: 'restatement', refundedRuns: f.refundedRuns, restartClock, window: { from: plan.from, to: plan.to }, parts: { bids: Math.round((f.bids.was - f.bids.restated) * MICRO) / MICRO, refunds: f.refunds } }, now);
      } else if (f.correction < 0) {
        throw new Error(`the restatement would charge ${f.firmId} more, which none of A, B or C can do; nothing was written`);
      }
      if (restartClock) restartNegativeClock(f.firmId, now);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return backup;
}

/** The plan as a table: per firm, the balance before, the correction and the balance after. */
export function describe(plan: Restatement): string {
  const pad = (s: string, n: number) => s.padStart(n);
  const lines = [
    `Restating ${plan.from} to ${plan.to}: ${plan.rounds.kept} of ${plan.rounds.was} rounds of bids stand under cooling off.`,
    '',
    `${'firm'.padEnd(16)}${pad('before', 12)}${pad('bids was', 11)}${pad('restated', 11)}${pad('refunds', 10)}${pad('correction', 12)}${pad('after', 12)}`,
  ];
  for (const f of plan.firms) {
    lines.push(
      `${f.name.slice(0, 15).padEnd(16)}${pad(creditsFixed(f.before), 12)}${pad(creditsFixed(f.bids.was), 11)}${pad(creditsFixed(f.bids.restated), 11)}${pad(creditsFixed(f.refunds), 10)}${pad(`+${creditsFixed(f.correction)}`, 12)}${pad(creditsFixed(f.after), 12)}`,
    );
  }
  const still = plan.firms.filter((f) => f.after < 0).map((f) => f.name);
  lines.push('', still.length ? `Still below zero after it, so their 72 hours start again: ${still.join(', ')}.` : 'No firm is below zero after it.');
  if (plan.alreadyApplied) lines.push('', 'The books were already restated once: nothing more will be written.');
  return lines.join('\n');
}

/** Whether anything answers on the engine's port. */
export function portAnswers(port: number, host = '127.0.0.1', ms = 1_000): Promise<boolean> {
  return new Promise((done) => {
    const sock = createConnection({ port, host });
    const finish = (up: boolean) => {
      sock.destroy();
      done(up);
    };
    sock.setTimeout(ms, () => finish(false));
    sock.once('connect', () => finish(true));
    sock.once('error', () => finish(false));
  });
}

export async function main(args: string[] = process.argv.slice(2), log: (s: string) => void = console.log, now: number = Date.now()): Promise<number> {
  const apply = args.includes('--apply');
  const unknown = args.filter((a) => a !== '--apply' && a !== '--dry-run');
  if (unknown.length || (apply && args.includes('--dry-run'))) {
    log('Usage: restate-economy [--dry-run | --apply]. A dry run is the default.');
    return 2;
  }
  if (await portAnswers(enginePort())) {
    log(`Refused: the engine answers on port ${enginePort()}. Stop it first; it keeps the books in memory.`);
    return 1;
  }
  log(`Data home: ${home()}`);
  const plan = planRestatement(now);
  log(describe(plan));
  if (!apply) {
    log('\nDry run: nothing written. Run again with --apply, the engine stopped, to book the corrections.');
    return 0;
  }
  if (plan.alreadyApplied) return 1;
  const backup = applyRestatement(plan, now);
  const after = balances();
  log(`\nBooked. The database before it is at ${backup}.`);
  for (const f of plan.firms) log(`${f.name}: ${creditsFixed(after[f.firmId] ?? 0)} credits now.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
