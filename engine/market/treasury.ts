/**
 * The treasury (spec 7.2, ruling 6): the firms' books. Every movement of
 * money is a `credits` row and a `credits.moved` ledger entry, so the
 * balances can be rebuilt from either alone.
 *
 * Rows and their sign for the firm named in `firm_id` (the `amount` column
 * is always a positive number of credits; the kind gives its direction):
 * - `bid`, `run`: what the firm's model calls cost (debit). They are written
 *   at call time by bids.ts and runs.ts through budget `charge()` (or by the
 *   Anthropic API backend itself), never here: the treasury only settles
 *   them into the ledger as `credits.moved` (one entry per firm, kind and
 *   run each time it settles), so nothing is ever charged twice.
 * - `pay`: the winning bid's price, from the city, when the job merges (credit).
 * - `review-pay`: REVIEWER_SHARE of the job's value, from the city, to the
 *   reviewer's firm, once per inspection (credit). The review and judge
 *   calls themselves are `review` and `judge` rows charged to the city;
 *   an Anthropic API review row carries the reviewer's firm id but is still
 *   the city's cost and never touches the firm's books.
 * - `hire`: the hiring fee, to the city (debit).
 * - `sale`: a dark tower's price, from the buyer to the city (debit); the
 *   bankrupt seller gets nothing.
 *
 * Money is summed in integer micro-credits, so 0.1 + 0.2 is 0.3.
 */
import { BANKRUPT_REASON, darkTowers, firm, hire, idleAgents, listFirms, quarters, retireFirm, sellTower, setFirmBooks } from './firms.js';
import { bidById } from './bids.js';
import { job as storedJob, listJobs, transition } from './jobs.js';
import { kill, liveRunIds, run as storedRun } from './runs.js';
import { canHire, HIRE_FEE, isBankrupt, REVIEWER_SHARE, salePrice, START_BALANCE } from '../../shared/market-rules.js';
import type { Bid, Inspection, Job, Trip } from '../../shared/types.js';
import { openDb } from '../db.js';
import { emit, subscribe, type Event } from '../events.js';
import { query, record, type LedgerEntry } from '../ledger.js';

export type MoneyKind = 'bid' | 'run' | 'pay' | 'review-pay' | 'hire' | 'sale';

/** The direction of each kind for the firm named on the row. */
export const FIRM_SIGN: Record<MoneyKind, 1 | -1> = { bid: -1, run: -1, pay: 1, 'review-pay': 1, hire: -1, sale: -1 };
const MONEY_KINDS = Object.keys(FIRM_SIGN) as MoneyKind[];
const COST_KINDS: MoneyKind[] = ['bid', 'run'];
/** How often the engine runs dailyTick. */
export const DAY_MS = 24 * 3600_000;
/** How often the engine runs bankruptcyTick. */
export const HOUR_MS = 3600_000;
/** A dark tower sells only to a firm left with at least this much after paying (ruling 6). */
export const SALE_MARGIN = 100;

const MICRO = 1_000_000;
const toMicro = (credits: number): number => Math.round(credits * MICRO);
const fromMicro = (micro: number): number => micro / MICRO;

/** One movement as the ledger records it. `delta` is signed for `firmId`. */
export interface CreditsMoved {
  kind: MoneyKind;
  firmId: string;
  from: string;
  to: string;
  amount: number;
  delta: number;
  rowIds: number[];
  runId: string | null;
  jobId: string | null;
  inspectionId: string | null;
  agentId: string | null;
  at: string;
}

let clock: () => number = () => Date.now();
/** The highest credits row id already settled into the ledger. */
let cursor = 0;

const iso = (ms: number) => new Date(ms).toISOString();
const msOf = (t: number | Date | string) => (typeof t === 'number' ? t : typeof t === 'string' ? Date.parse(t) : t.getTime());

let depth = 0;
let pending: Array<[string, object]> = [];

/** Emits now, or once the outermost atomic block has written everything. */
function later(type: string, data: object): void {
  if (depth > 0) pending.push([type, data]);
  else emit(type, data);
}

/**
 * Runs `fn` so its rows and ledger entries land together or not at all (a
 * savepoint, so it also nests inside a caller's transaction). Events wait
 * until the outermost block has written; a failure drops them and puts the
 * settle cursor back.
 */
function atomically<T>(fn: () => T): T {
  const db = openDb();
  const savedCursor = cursor;
  db.exec('SAVEPOINT treasury');
  depth++;
  try {
    const out = fn();
    db.exec('RELEASE treasury');
    depth--;
    if (depth === 0) {
      const ready = pending;
      pending = [];
      for (const [type, data] of ready) emit(type, data);
    }
    return out;
  } catch (err) {
    depth--;
    try {
      db.exec('ROLLBACK TO treasury');
      db.exec('RELEASE treasury');
    } catch {
      // the savepoint is already gone
    }
    cursor = savedCursor;
    if (depth === 0) pending = [];
    throw err;
  }
}

/** The highest credits row any `credits.moved` entry names, read through the ledger's kind index. */
function settledThrough(): number {
  const row = openDb()
    .prepare("SELECT MAX(CAST(r.value AS INTEGER)) AS max FROM ledger, json_each(ledger.json, '$.rowIds') AS r WHERE ledger.kind = 'credits.moved' AND r.type = 'integer'")
    .get() as { max: number | bigint | null } | undefined;
  return Number(row?.max ?? 0);
}

function move(m: CreditsMoved): void {
  record('credits.moved', m);
  later('credits.moved', m);
}

/**
 * Records every cost row (`bid`, `run`) written since the last settle as a
 * `credits.moved`, one per firm, kind and run, then brings the stored books
 * up to date. Bids that sat out were charged too, so they settle here as well.
 */
export function settle(now: number = clock()): void {
  atomically(() => {
    const rows = openDb()
      .prepare('SELECT id, firm_id, run_id, kind, amount FROM credits WHERE id > ? ORDER BY id')
      .all(cursor) as Array<{ id: number | bigint; firm_id: string | null; run_id: string | null; kind: string; amount: number }>;
    const groups = new Map<string, { kind: MoneyKind; firmId: string; runId: string | null; micro: number; rowIds: number[] }>();
    let through = cursor;
    for (const r of rows) {
      const id = Number(r.id);
      if (id > through) through = id;
      if (!r.firm_id || !COST_KINDS.includes(r.kind as MoneyKind)) continue;
      const key = `${r.kind}\u0000${r.firm_id}\u0000${r.run_id ?? ''}`;
      const g = groups.get(key) ?? { kind: r.kind as MoneyKind, firmId: r.firm_id, runId: r.run_id, micro: 0, rowIds: [] };
      g.micro += toMicro(r.amount);
      g.rowIds.push(id);
      groups.set(key, g);
    }
    for (const g of groups.values()) {
      move({
        kind: g.kind,
        firmId: g.firmId,
        from: g.firmId,
        to: 'spent',
        amount: fromMicro(g.micro),
        delta: -fromMicro(g.micro),
        rowIds: g.rowIds,
        runId: g.runId,
        jobId: null,
        inspectionId: null,
        agentId: null,
        at: iso(now),
      });
    }
    // Only once every movement is recorded does the cursor pass those rows.
    cursor = through;
    updateBooks(now);
  });
}

/** Writes each firm's balance and, while it is below zero, since when (ruling 6: 72 hours continuously). */
function updateBooks(now: number): void {
  const b = balances();
  for (const f of listFirms()) {
    const bal = b[f.id] ?? START_BALANCE;
    const negativeSince = bal < 0 ? (f.negativeSince ?? iso(now)) : null;
    setFirmBooks(f.id, bal, negativeSince);
  }
}

/** Writes a money row the treasury itself moves (pay, review-pay, hire, sale) and its ledger entry. */
function transfer(o: { kind: Exclude<MoneyKind, 'bid' | 'run'>; firmId: string; micro: number; runId?: string | null; jobId?: string | null; inspectionId?: string | null; agentId?: string | null; extra?: object }, now: number): CreditsMoved | null {
  if (!(o.micro > 0)) return null;
  return atomically(() => {
    // Settle first, so the cursor never passes a cost row that was not yet in the ledger.
    settle(now);
    const credits = fromMicro(o.micro);
    const inbound = FIRM_SIGN[o.kind] > 0;
    const from = inbound ? 'city' : o.firmId;
    const to = inbound ? o.firmId : 'city';
    const result = openDb()
      .prepare('INSERT INTO credits (at, firm_id, run_id, kind, amount, usd, json) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        iso(now),
        o.firmId,
        o.runId ?? null,
        o.kind,
        credits,
        null,
        JSON.stringify({ kind: o.kind, from, to, credits, jobId: o.jobId ?? null, inspectionId: o.inspectionId ?? null, agentId: o.agentId ?? null, ...(o.extra ?? {}) }),
      );
    const id = Number(result.lastInsertRowid);
    const m: CreditsMoved = {
      kind: o.kind,
      firmId: o.firmId,
      from,
      to,
      amount: credits,
      delta: inbound ? credits : -credits,
      rowIds: [id],
      runId: o.runId ?? null,
      jobId: o.jobId ?? null,
      inspectionId: o.inspectionId ?? null,
      agentId: o.agentId ?? null,
      at: iso(now),
    };
    move(m);
    cursor = Math.max(cursor, id);
    updateBooks(now);
    return m;
  });
}

function hasRow(kind: MoneyKind, key: 'jobId' | 'inspectionId', value: string): boolean {
  return Boolean(openDb().prepare(`SELECT 1 FROM credits WHERE kind = ? AND json_extract(json, '$.${key}') = ? LIMIT 1`).get(kind, value));
}

/** The bid holding a job: its `awardedBid`, else the last award the ledger shows. */
function winningBid(j: Job): Bid | null {
  if (j.awardedBid) {
    const b = bidById(j.awardedBid);
    if (b) return b;
  }
  let chosen: Bid | null = null;
  for (const e of query({ kind: 'job.awarded', jobId: j.id })) {
    const d = e.data as { chosen?: Bid | null };
    if (d.chosen) chosen = d.chosen;
  }
  return chosen;
}

/** On merge the winning firm is paid its price by the city, once per job. A PR merged with someone else's changes never reaches `merged`. */
function payMerge(j: Job, now: number): void {
  if (hasRow('pay', 'jobId', j.id)) return;
  if (j.runId && storedRun(j.runId)?.mergedWithChanges) return;
  const bid = winningBid(j);
  if (!bid) {
    console.warn(`palimpsest: ${j.id} merged with no winning bid on record; nothing paid`);
    return;
  }
  const winner = firm(bid.firmId);
  if (winner?.status === 'bankrupt') {
    // The work merged and its floors stand, but the firm is dissolved: nobody is paid.
    if (alreadyNoted(j.id)) return;
    const note = `merged after ${winner.name} went bankrupt: nobody was paid ${bid.price} credits (the firm is dissolved)`;
    const data = { runId: j.runId, jobId: j.id, repo: j.repo, firmId: winner.id, note, unpaid: bid.price, at: iso(now) };
    record('run.note', data);
    later('run.note', data);
    return;
  }
  transfer({ kind: 'pay', firmId: bid.firmId, micro: toMicro(bid.price), jobId: j.id, runId: j.runId, agentId: bid.agentId, extra: { bidId: bid.id } }, now);
}

function alreadyNoted(jobId: string): boolean {
  return query({ kind: 'run.note', jobId }).some((e) => (e.data as { unpaid?: unknown }).unpaid !== undefined);
}

/** The reviewer's firm is paid REVIEWER_SHARE of the job's value by the city, once per inspection; nobody is paid when no reviewer read it. */
function payReviewer(insp: Inspection, now: number): void {
  if (!insp?.id || !insp.reviewerFirmId || !insp.reviewerAgentId) return;
  if (hasRow('review-pay', 'inspectionId', insp.id)) return;
  const value = storedJob(insp.jobId)?.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return;
  const micro = Math.round(value * REVIEWER_SHARE * MICRO);
  transfer({ kind: 'review-pay', firmId: insp.reviewerFirmId, micro, jobId: insp.jobId, runId: insp.runId, inspectionId: insp.id, agentId: insp.reviewerAgentId }, now);
}

function onEvent(e: Event): void {
  const now = clock();
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case 'bid.placed':
    case 'bid.satOut':
    case 'run.ended':
      // The cost rows are already written: settle them into the ledger, never charge again.
      settle(now);
      return;
    case 'job.changed': {
      const j = d.job as Job | undefined;
      if (j?.status === 'merged') payMerge(j, now);
      return;
    }
    case 'inspection.done':
      payReviewer(d.inspection as Inspection, now);
      return;
    default:
  }
}

/**
 * Subscribes the treasury to the event bus and returns the unsubscribe.
 * `now` is the clock its rows and books are stamped with (tests inject it).
 */
export function installTreasury(o: { now?: () => number } = {}): () => void {
  clock = o.now ?? (() => Date.now());
  cursor = settledThrough();
  const off = subscribe((e) => {
    try {
      onEvent(e);
    } catch (err) {
      console.error(`palimpsest: the treasury could not book ${e.type}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return off;
}

/** The SQL sign of each money kind for the firm on the row, as FIRM_SIGN has it. */
const SIGN_SQL = `CASE c.kind ${MONEY_KINDS.map((k) => `WHEN '${k}' THEN ${FIRM_SIGN[k]}`).join(' ')} ELSE 0 END`;
const KIND_SQL = MONEY_KINDS.map((k) => `'${k}'`).join(', ');

/** Every firm's opening, from its first `firm.seeded` entry, read in one pass through the ledger's kind index. */
function openings(): Map<string, number> {
  const rows = openDb()
    .prepare("SELECT json_extract(json, '$.firm.id') AS firm, json_extract(json, '$.firm.balance') AS balance FROM ledger WHERE kind = 'firm.seeded' ORDER BY id")
    .all() as Array<{ firm: string | null; balance: number | null }>;
  const out = new Map<string, number>();
  for (const r of rows) if (r.firm && typeof r.balance === 'number' && !out.has(r.firm)) out.set(r.firm, r.balance);
  return out;
}

/**
 * Every firm's balance, rebuilt from the credits rows and each firm's seeded
 * balance (the start balance for a firm with no seed on record), as replay
 * does: one signed sum per firm in integer micro-credits, so it stays exact.
 */
export function balances(): Record<string, number> {
  const seeded = openings();
  const rows = openDb()
    .prepare(
      `SELECT f.id AS firm, COALESCE(SUM(${SIGN_SQL} * CAST(ROUND(c.amount * 1000000) AS INTEGER)), 0) AS micro
       FROM firms f LEFT JOIN credits c ON c.firm_id = f.id AND c.kind IN (${KIND_SQL})
       GROUP BY f.id`,
    )
    .all() as Array<{ firm: string; micro: number | bigint }>;
  const out: Record<string, number> = {};
  for (const r of rows) out[r.firm] = fromMicro(toMicro(seeded.get(r.firm) ?? START_BALANCE) + Number(r.micro));
  return out;
}

/**
 * Since when a firm has been below zero by its rows (charges not yet
 * settled included): the time of the row that took it below zero this
 * time, or null when it stands at or above zero. Stable across reads.
 */
export function negativeSinceOf(firmId: string): string | null {
  const opening = openings().get(firmId) ?? START_BALANCE;
  const rows = openDb()
    .prepare(`SELECT c.at AS at, ${SIGN_SQL} * CAST(ROUND(c.amount * 1000000) AS INTEGER) AS micro FROM credits c WHERE c.firm_id = ? AND c.kind IN (${KIND_SQL}) ORDER BY c.id`)
    .all(firmId) as Array<{ at: string; micro: number | bigint }>;
  let micro = toMicro(opening);
  let since: string | null = null;
  for (const r of rows) {
    const was = micro;
    micro += Number(r.micro);
    if (micro < 0 && was >= 0) since = r.at;
    else if (micro >= 0) since = null;
  }
  return micro < 0 ? since : null;
}

/** Every firm's balance, rebuilt from the ledger alone: each firm's seeded balance plus its `credits.moved` deltas. */
export function replayBalances(log: LedgerEntry[]): Record<string, number> {
  const micro: Record<string, number> = {};
  for (const e of log) {
    if (e.kind === 'firm.seeded') {
      const f = (e.data as { firm?: { id?: string; balance?: number } }).firm;
      if (f?.id) micro[f.id] = toMicro(typeof f.balance === 'number' ? f.balance : START_BALANCE);
    } else if (e.kind === 'credits.moved') {
      const m = e.data as CreditsMoved;
      if (!m.firmId) continue;
      micro[m.firmId] = (micro[m.firmId] ?? toMicro(START_BALANCE)) + toMicro(m.delta);
    }
  }
  return Object.fromEntries(Object.entries(micro).map(([k, v]) => [k, fromMicro(v)]));
}

/** Ends every live trip of a firm's people (its agents just retired). */
function endTrips(firmId: string, now: number): void {
  const rows = openDb().prepare('SELECT id, json FROM trips').all() as Array<{ id: string; json: string }>;
  for (const row of rows) {
    const t = JSON.parse(row.json) as Trip;
    if (t.firmId !== firmId || t.endedAt) continue;
    const ended: Trip = { ...t, endedAt: iso(now) };
    openDb().prepare('UPDATE trips SET json = ? WHERE id = ?').run(JSON.stringify(ended), row.id);
    const data = { tripId: t.id, agentId: t.agentId, firmId, reason: BANKRUPT_REASON, at: iso(now) };
    record('trip.ended', data);
    later('trip.ended', data);
  }
}

/** Firms with a run in a live stage right now. */
export function liveFirmIds(): Set<string> {
  const out = new Set<string>();
  for (const id of liveRunIds()) {
    const r = storedRun(id);
    if (r) out.add(r.firmId);
  }
  return out;
}

/**
 * Declares a firm bankrupt: its agents retire and their towers go dark,
 * its people's trips end, its live runs are killed (they end `killed`, so
 * their jobs return to the board without spending an attempt) and its
 * awarded jobs that had not started go back on the board. A waiting PR is
 * left open: if he merges it, the floors still go up but nobody is paid.
 */
function declareBankrupt(firmId: string, now: number): void {
  atomically(() => {
    retireFirm(firmId, new Date(now));
    endTrips(firmId, now);
    for (const j of listJobs({ status: 'awarded' })) {
      const b = j.awardedBid ? bidById(j.awardedBid) : null;
      if (b?.firmId !== firmId) continue;
      if (j.runId && liveRunIds().includes(j.runId)) continue;
      transition(j, 'open', { awardedBid: null, bidsCloseAt: null });
    }
    later('firm.bankrupt', { firmId, at: iso(now) });
  });
  const reason = `${firm(firmId)?.name ?? firmId} went bankrupt.`;
  for (const id of liveRunIds()) if (storedRun(id)?.firmId === firmId) kill(id, reason);
}

/**
 * The hourly pass: settles the cost rows and declares bankrupt every active
 * firm that has been below zero for 72 hours without a break (ruling 6).
 */
export function bankruptcyTick(now: number | Date = clock()): void {
  const t = msOf(now);
  settle(t);
  for (const f of listFirms()) {
    if (f.status !== 'active' || !isBankrupt(f.negativeSince, t)) continue;
    declareBankrupt(f.id, t);
  }
}

/**
 * The once-a-day pass (ruling 6): settles the cost rows, sells every dark
 * tower of a firm that went bankrupt on an earlier tick and has no run left
 * live to the richest active firm holding its price plus SALE_MARGIN
 * (re-clad in the buyer's root on its plot), then lets each active firm
 * that canHire() hire one specialist for HIRE_FEE.
 */
export function dailyTick(now: number | Date = clock(), opts: { sales?: boolean } = {}): void {
  const t = msOf(now);
  settle(t);
  if (opts.sales !== false) sellDarkTowers(t);
  hireSpecialists(t);
}

/**
 * The daily tick's sales (ruling 6): every dark tower of a firm that went
 * bankrupt before `now` and has no run left live goes to the richest active
 * firm that holds its price plus SALE_MARGIN. The sample economy can hold
 * them back and sell them live, so a capture sees the re-clad.
 */
export function sellDarkTowers(now: number | Date = clock()): void {
  const t = msOf(now);
  // Sales: towers that went dark on an earlier tick, of firms with no run still winding down.
  for (const tower of darkTowers(liveFirmIds())) {
    const seller = firm(tower.firmId);
    if (!seller?.bankruptAt || Date.parse(seller.bankruptAt) >= t) continue;
    const price = salePrice(tower.floors);
    const b = balances();
    const richest = listFirms()
      .filter((f) => f.status === 'active')
      .sort((x, y) => (b[y.id] ?? 0) - (b[x.id] ?? 0) || x.slot - y.slot)[0];
    if (!richest || (b[richest.id] ?? 0) < price + SALE_MARGIN) continue;
    atomically(() => {
      // sellTower records tower.sold with the price; the treasury only moves the money, in the same write.
      const sold = sellTower(tower.agentId, richest.id, price);
      if (!sold) return;
      transfer({ kind: 'sale', firmId: richest.id, micro: toMicro(price), agentId: tower.agentId, extra: { seller: tower.firmId } }, t);
      later('tower.sold', { from: tower.firmId, to: richest.id, price, agentId: tower.agentId });
    });
  }
}

/** The daily tick's hiring: one specialist per firm per tick. */
function hireSpecialists(t: number): void {
  const openJobs = (openDb().prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('open', 'bidding')").get() as { n: number }).n;
  for (const f of listFirms()) {
    const b = balances();
    const towers = quarters().find((q) => q.firmId === f.id)?.towers.length ?? 0;
    if (!canHire(b[f.id] ?? 0, openJobs, idleAgents(f.id).length, towers, f.status)) continue;
    atomically(() => {
      const a = hire(f.id, new Date(t));
      if (!a) return;
      transfer({ kind: 'hire', firmId: f.id, micro: toMicro(HIRE_FEE), agentId: a.id }, t);
      later('agent.hired', { agent: a });
    });
  }
}

export interface CityDay {
  from: string;
  to: string;
  /** What the city's plan spent on model calls, by kind (bids and runs are charged to the firms). */
  spent: { bid: number; run: number; review: number; judge: number; total: number };
  /** What the city paid out to firms. */
  paid: { pay: number; reviewPay: number; total: number };
  /** What firms paid the city. */
  received: { hire: number; sale: number; total: number };
  /** received minus paid, in credits. */
  net: number;
  /** Each firm's net change from its rows in the range. */
  firms: Record<string, number>;
}

/** The city's books between `dayStart` (inclusive) and `dayEnd` (exclusive), for the daily report. */
export function cityLedger(dayStart: string | number | Date, dayEnd: string | number | Date): CityDay {
  const from = iso(msOf(dayStart));
  const to = iso(msOf(dayEnd));
  const rows = openDb().prepare('SELECT firm_id, kind, amount FROM credits WHERE at >= ? AND at < ?').all(from, to) as Array<{ firm_id: string | null; kind: string; amount: number }>;
  const sum: Record<string, number> = {};
  const firms: Record<string, number> = {};
  for (const r of rows) {
    sum[r.kind] = (sum[r.kind] ?? 0) + toMicro(r.amount);
    if (r.firm_id && r.kind in FIRM_SIGN) firms[r.firm_id] = (firms[r.firm_id] ?? 0) + FIRM_SIGN[r.kind as MoneyKind] * toMicro(r.amount);
  }
  const s = (k: string) => sum[k] ?? 0;
  const spentTotal = s('bid') + s('run') + s('review') + s('judge');
  const paidTotal = s('pay') + s('review-pay');
  const receivedTotal = s('hire') + s('sale');
  return {
    from,
    to,
    spent: { bid: fromMicro(s('bid')), run: fromMicro(s('run')), review: fromMicro(s('review')), judge: fromMicro(s('judge')), total: fromMicro(spentTotal) },
    paid: { pay: fromMicro(s('pay')), reviewPay: fromMicro(s('review-pay')), total: fromMicro(paidTotal) },
    received: { hire: fromMicro(s('hire')), sale: fromMicro(s('sale')), total: fromMicro(receivedTotal) },
    net: fromMicro(receivedTotal - paidTotal),
    firms: Object.fromEntries(Object.entries(firms).map(([k, v]) => [k, fromMicro(v)])),
  };
}
