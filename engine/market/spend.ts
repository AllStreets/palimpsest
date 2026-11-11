/**
 * What the city's model calls cost (Task 39), as the treasury screen shows
 * it: today and this week by firm and by model, and the credits entries
 * behind each row. Bids and runs are the firms' own cost; reviews and design
 * checks are the city's, whichever firm's agent made them. Summed in integer
 * micro-credits, so a row adds up exactly to its entries.
 */
import { CREDIT_PCT } from '../../shared/credits.js';
import type { CreditEntry, SpendPeriod } from '../../shared/types.js';
import { openDb } from '../db.js';

/** The credits row kinds that are a model call. */
const CALL_KINDS = "('bid', 'run', 'review', 'judge')";
/** The firm a call is charged to, or '' for the city's own (reviews and design checks). */
const PAYER = "CASE WHEN c.kind IN ('bid', 'run') AND c.firm_id IS NOT NULL THEN c.firm_id ELSE '' END";
const MODEL = "COALESCE(json_extract(c.json, '$.model'), '')";
/** The key the city's own calls are asked for by: a firm id never starts with '~', so no firm can take it. */
export const CITY_KEY = '~city';
/** The most entries one row opens to. */
export const ENTRY_ROWS = 50;

const MICRO = 1_000_000;
const fromMicro = (m: number): number => m / MICRO;
const iso = (ms: number): string => new Date(ms).toISOString();
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Local midnight before `now`. */
export function dayStart(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The bounds of a period on the screen: today from local midnight, the week as the last seven days. */
export function periodBounds(period: 'today' | 'week', now: number): { from: number; to: number } {
  return { from: period === 'today' ? dayStart(now) : now - 7 * 24 * 3600_000, to: now };
}

/** The city's model calls between `fromMs` and `toMs` (both inclusive), by firm and by model. */
export function spendBetween(fromMs: number, toMs: number): SpendPeriod {
  const rows = openDb()
    .prepare(
      `SELECT ${PAYER} AS payer, ${MODEL} AS model,
         SUM(CAST(ROUND(c.amount * 1000000) AS INTEGER)) AS micro, SUM(COALESCE(c.usd, 0)) AS usd, COUNT(*) AS n
       FROM credits c WHERE c.kind IN ${CALL_KINDS} AND c.at >= ? AND c.at <= ?
       GROUP BY payer, model`,
    )
    .all(iso(fromMs), iso(toMs)) as Array<{ payer: string; model: string; micro: number | bigint; usd: number; n: number }>;
  const firms = new Map<string, { micro: number; usd: number; n: number }>();
  const models = new Map<string, { micro: number; usd: number; n: number; claude: boolean }>();
  let total = 0;
  for (const r of rows) {
    const micro = Number(r.micro);
    total += micro;
    const f = firms.get(r.payer) ?? { micro: 0, usd: 0, n: 0 };
    f.micro += micro;
    f.usd += r.usd;
    f.n += r.n;
    firms.set(r.payer, f);
    // Only Claude calls draw on his plan's window.
    const m = models.get(r.model) ?? { micro: 0, usd: 0, n: 0, claude: r.model.startsWith('claude:') };
    m.micro += micro;
    m.usd += r.usd;
    m.n += r.n;
    models.set(r.model, m);
  }
  return {
    from: iso(fromMs),
    to: iso(toMs),
    total: fromMicro(total),
    firms: [...firms.entries()]
      .map(([payer, f]) => ({ firmId: payer || null, credits: fromMicro(f.micro), usd: round2(f.usd), entries: f.n }))
      .sort((a, b) => b.credits - a.credits || String(a.firmId).localeCompare(String(b.firmId))),
    models: [...models.entries()]
      .map(([model, m]) => ({ model: model || 'unknown', credits: fromMicro(m.micro), usd: round2(m.usd), entries: m.n, windowPct: m.claude ? Math.round(fromMicro(m.micro) * CREDIT_PCT * 1e6) / 1e6 : null }))
      .sort((a, b) => b.credits - a.credits || a.model.localeCompare(b.model)),
  };
}

/**
 * The credits entries behind one row of the spend tables, newest first:
 * a firm's bids and runs (`firm: CITY_KEY` for the city's own reviews and
 * design checks), or one model's calls, in a period.
 */
export function creditEntries(q: { fromMs: number; toMs: number; firm?: string; model?: string; limit?: number }): { rows: CreditEntry[]; count: number; total: number } {
  const where = [`c.kind IN ${CALL_KINDS}`, 'c.at >= ?', 'c.at <= ?'];
  const args: Array<string | number> = [iso(q.fromMs), iso(q.toMs)];
  if (q.firm !== undefined) {
    where.push(`${PAYER} = ?`);
    args.push(q.firm === CITY_KEY ? '' : q.firm);
  }
  if (q.model !== undefined) {
    where.push(`${MODEL} = ?`);
    args.push(q.model === 'unknown' ? '' : q.model);
  }
  const db = openDb();
  const sum = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(CAST(ROUND(c.amount * 1000000) AS INTEGER)), 0) AS micro FROM credits c WHERE ${where.join(' AND ')}`)
    .get(...args) as { n: number; micro: number | bigint };
  const rows = db
    .prepare(
      `SELECT c.id AS id, c.at AS at, c.kind AS kind, c.firm_id AS firmId, c.run_id AS runId, r.job_id AS jobId, ${MODEL} AS model,
         c.amount AS credits, c.usd AS usd, json_extract(c.json, '$.unattended') AS unattended
       FROM credits c LEFT JOIN runs r ON r.id = c.run_id
       WHERE ${where.join(' AND ')} ORDER BY c.at DESC, c.id DESC LIMIT ?`,
    )
    .all(...args, q.limit ?? ENTRY_ROWS) as Array<Omit<CreditEntry, 'unattended'> & { id: number | bigint; unattended: number | null }>;
  return {
    rows: rows.map((r) => ({ ...r, id: Number(r.id), model: r.model || 'unknown', unattended: r.unattended === 1 })),
    count: Number(sum.n),
    total: fromMicro(Number(sum.micro)),
  };
}
