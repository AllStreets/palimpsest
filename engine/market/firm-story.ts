/**
 * A firm's story as its page tells it (Task 38), read from the ledger alone:
 * its books as a running balance, every round it bid in (won, or lost with
 * the expected value that lost it), and its deals: the specialists it hired,
 * the dark towers it bought and the towers sold out of its quarter.
 * Read-only: nothing here writes.
 */
import { HIRE_FEE, START_BALANCE } from '../../shared/market-rules.js';
import type { Bid, BookRow, FirmDeal, FirmRound, Tier } from '../../shared/types.js';
import { openDb } from '../db.js';
import { query } from '../ledger.js';
import { job } from './jobs.js';
import { listRuns } from './runs.js';

const MICRO = 1_000_000;
const toMicro = (credits: number): number => Math.round(credits * MICRO);
const fromMicro = (micro: number): number => micro / MICRO;

type Data = Record<string, unknown>;

const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** The most movements of a firm's books, and of its rounds, its page is sent (the newest). */
export const BOOK_ROWS = 1000;
export const ROUND_ROWS = 400;

type Row = { id: number | bigint; at: string; json: string };

/** A firm's newest book movements, through the ledger's per-firm index on credits.moved (test/ledger.test.ts pins the plan). */
export const BOOKS_SQL = "SELECT id, at, json FROM ledger WHERE kind = 'credits.moved' AND json_extract(json, '$.firmId') = ? ORDER BY id DESC LIMIT ?";
/** How many of a firm's movements are older than the page kept, and what they sum to in micro-credits, through the same index. */
export const OLDER_SQL = "SELECT COUNT(*) AS n, COALESCE(SUM(CAST(ROUND(json_extract(json, '$.delta') * 1000000) AS INTEGER)), 0) AS micro FROM ledger WHERE kind = 'credits.moved' AND json_extract(json, '$.firmId') = ? AND id < ?";

/** The firm's balance as `firm.seeded` set it (the start balance for a firm seeded before that was recorded). */
function openingOf(firmId: string): number {
  const row = openDb()
    .prepare("SELECT json FROM ledger WHERE kind = 'firm.seeded' AND json_extract(json, '$.firm.id') = ? ORDER BY id LIMIT 1")
    .get(firmId) as { json: string } | undefined;
  return num(row ? (JSON.parse(row.json) as { firm?: Data }).firm?.balance : null) ?? START_BALANCE;
}

export interface FirmBooks {
  /** What the firm opened with: its `firm.seeded` balance. */
  opening: number;
  /** True when older movements were left out; the first row kept still starts where they left the balance. */
  truncated: boolean;
  rows: BookRow[];
}

/**
 * The firm's books: its newest `limit` `credits.moved` entries, oldest
 * first, each with the balance it left. Read per firm through the ledger's
 * kind index; the balance starts from `firm.seeded` plus everything older
 * than the rows kept, summed in micro-credits as the treasury sums it, so the
 * last row's balance is the treasury's.
 */
export function firmBooks(firmId: string, limit = BOOK_ROWS): FirmBooks {
  const db = openDb();
  const opening = openingOf(firmId);
  const recent = (
    db
      .prepare(BOOKS_SQL)
      .all(firmId, limit) as Row[]
  ).reverse();
  const firstKept = recent.length ? Number(recent[0].id) : Number.MAX_SAFE_INTEGER;
  const older = db
    .prepare(OLDER_SQL)
    .get(firmId, firstKept) as { n: number; micro: number | bigint };
  let micro = toMicro(opening) + Number(older.micro);
  const out: BookRow[] = [];
  // A run's cost names its run, not its job: the page says which job the work was for.
  const titles = new Map<string, string | null>();
  const jobOfRun = new Map(listRuns().filter((r) => r.firmId === firmId).map((r) => [r.id, r.jobId] as const));
  for (const e of recent) {
    const d = JSON.parse(e.json) as Data;
    const delta = num(d.delta);
    if (delta === null) continue;
    micro += toMicro(delta);
    const jobId = str(d.jobId) ?? jobOfRun.get(str(d.runId) ?? '') ?? null;
    if (jobId && !titles.has(jobId)) titles.set(jobId, job(jobId)?.title ?? null);
    out.push({ at: str(d.at) ?? e.at, kind: str(d.kind) ?? 'other', delta, balance: fromMicro(micro), runId: str(d.runId), jobId, agentId: str(d.agentId), title: jobId ? (titles.get(jobId) ?? null) : null });
  }
  // Bid and run costs are charged as the models are called and settled into the ledger afterwards:
  // what is charged but not yet settled closes the books as one pending line, so they end where the
  // treasury's rows do.
  // A row is settled when a credits.moved entry of its firm names it (one anti-join on the ledger's per-firm index, its list built once; a later row booked first says nothing about it).
  const p = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(ROUND(c.amount * 1000000) AS INTEGER)), 0) AS micro, MAX(c.at) AS at FROM credits c
       WHERE c.firm_id = ? AND c.kind IN ('bid', 'run') AND c.id NOT IN (
         SELECT CAST(r.value AS INTEGER) FROM ledger l, json_each(l.json, '$.rowIds') AS r
         WHERE l.kind = 'credits.moved' AND json_extract(l.json, '$.firmId') = ? AND r.type = 'integer')`,
    )
    .get(firmId, firmId) as { micro: number | bigint; at: string | null };
  // Stamped no earlier than the last booked line, so newest first it heads the books and never repeats a day.
  const lastAt = out.at(-1)?.at ?? '';
  const pending = { micro: Number(p.micro), at: p.at && p.at > lastAt ? p.at : lastAt || p.at };
  if (pending.micro > 0) {
    micro -= pending.micro;
    out.push({ at: pending.at ?? new Date().toISOString(), kind: 'pending', delta: -fromMicro(pending.micro), balance: fromMicro(micro), runId: null, jobId: null, agentId: null, title: null });
  }
  return { opening, truncated: Number(older.n) > 0, rows: out };
}

/** The highest expected value first, then the earlier bid. */
const better = (a: Bid, b: Bid): number => b.ev - a.ev || a.at.localeCompare(b.at);

/**
 * Every round the firm bid in, oldest first: its best bid of the round, the
 * bid that won it (null when no bid was worth taking) and, for a round it
 * won, what became of the work.
 */
export function firmRounds(firmId: string, limit = ROUND_ROWS): FirmRound[] {
  // Only the rounds this firm bid in, newest first, capped before any job is read.
  const rows = (
    openDb()
      .prepare(
        "SELECT id, at, json FROM ledger WHERE kind = 'job.awarded' AND EXISTS (SELECT 1 FROM json_each(ledger.json, '$.considered') AS c WHERE json_extract(c.value, '$.firmId') = ?) ORDER BY id DESC LIMIT ?",
      )
      .all(firmId, limit) as Row[]
  ).reverse();
  const outcomes = new Map(listRuns().filter((r) => r.firmId === firmId).map((r) => [r.bidId, r.outcome ?? (r.stage === 'done' ? null : 'live')] as const));
  const out: FirmRound[] = [];
  for (const e of rows) {
    const d = JSON.parse(e.json) as Data;
    const considered = Array.isArray(d.considered) ? (d.considered as Bid[]) : [];
    const mine = considered.filter((b) => b && b.firmId === firmId).sort(better);
    if (!mine.length) continue;
    const chosen = (d.chosen as Bid | null | undefined) ?? null;
    const won = chosen?.firmId === firmId;
    const bid = won ? chosen! : mine[0];
    const jobId = str(d.jobId) ?? bid.jobId;
    const j = job(jobId);
    out.push({
      jobId,
      title: j?.title ?? jobId,
      repo: j?.repo ?? '',
      tier: (j?.tier ?? str(d.tier) ?? 'normal') as Tier,
      value: j?.value ?? 0,
      at: str(d.at) ?? e.at,
      won,
      bid,
      winner: chosen,
      outcome: won ? (outcomes.get(chosen!.id) ?? null) : null,
    });
  }
  return out;
}

/** The firm's hires, purchases and sales, oldest first. */
export function firmDeals(firmId: string): FirmDeal[] {
  const out: FirmDeal[] = [];
  // What each hire cost, from the treasury's own movement when the hire event does not say.
  const fees = new Map<string, number>();
  for (const r of openDb()
    .prepare("SELECT json FROM ledger WHERE kind = 'credits.moved' AND json_extract(json, '$.firmId') = ? AND json_extract(json, '$.kind') = 'hire'")
    .all(firmId) as Array<{ json: string }>) {
    const m = JSON.parse(r.json) as Data;
    const agentId = str(m.agentId);
    const amount = num(m.amount);
    if (agentId && amount !== null) fees.set(agentId, amount);
  }
  for (const e of query({ kind: ['agent.hired', 'tower.sold'] })) {
    const d = e.data as Data;
    if (e.kind === 'agent.hired') {
      const a = d.agent as Data | undefined;
      if (a?.firmId === firmId && typeof a.id === 'string') out.push({ kind: 'hired', at: e.at, agentId: a.id, other: null, price: num(d.fee) ?? fees.get(a.id) ?? HIRE_FEE });
      continue;
    }
    const agentId = str(d.agentId);
    const price = num(d.price) ?? 0;
    if (!agentId) continue;
    if (d.to === firmId) out.push({ kind: 'bought', at: e.at, agentId, other: str(d.from), price });
    else if (d.from === firmId) out.push({ kind: 'sold', at: e.at, agentId, other: str(d.to), price });
  }
  return out;
}
