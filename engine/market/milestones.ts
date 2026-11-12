/**
 * Milestones (spec 18, Phase 3 Task 7, ruling 11): the few things the city
 * marks on a tower, reached from the floors as the bus emits them and from
 * nothing else. The lit spire stands on the tower with the greatest earned
 * height above its datum (Decision 3); a tower that loses it keeps its mast
 * unlit. The tallest tower by total height carries the founding skyline, an
 * unlit finial in its own row. A repo quiet `QUIET_DAYS` gets scaffolding
 * lights for `LIGHTS_DAYS` on its first lit floor. A firm's first PR floor
 * wears a ribbon until `RIBBON_DAYS` after it merges, or until the PR closes
 * or the firm goes bankrupt (Decision 4).
 *
 * Every reach writes the `milestones` row, records `milestone.reached
 * { milestone }` once by id and emits it; a patch writes the row and records
 * and emits the patched row again, so replay rebuilds the table from the
 * ledger. Milestones are never counted or scored: each is shown in the city,
 * in the brief the morning it happens, and on its floor's row. Backfilled
 * once from the towers at engine start.
 *
 * The week tour (ruling 12) is planned here from the ledger and the towers
 * that stand now; `shared/tour.ts` holds the pure plan.
 */
import { LIGHTS_DAYS, QUIET_DAYS, RIBBON_DAYS } from '../../shared/market-rules.js';
import { tourPlan, weekOf, type TourEvent } from '../../shared/tour.js';
import { layoutTower } from '../../shared/tower-layout.js';
import type { Agent, Floor, Job, Milestone, Tour, TowerSpec } from '../../shared/types.js';
import { openDb } from '../db.js';
import { subscribe, emit, type Event } from '../events.js';
import { query, record } from '../ledger.js';
import { city, earnedFloors, loadTower } from '../repos.js';
import { agentTowerId, listAgents, listFirms, quarters } from './firms.js';
import { job as storedJob, plain } from './jobs.js';

const DAY_MS = 24 * 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const districtTower = (towerId: string) => towerId.endsWith('#founding');
const shortName = (repo: string) => repo.slice(repo.indexOf('/') + 1);

// ---------------------------------------------------------------- the rows

function loadRow(id: string): Milestone | null {
  const row = openDb().prepare('SELECT json FROM milestones WHERE id = ?').get(id) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as Milestone) : null;
}

function allRows(): Milestone[] {
  const rows = openDb().prepare('SELECT json FROM milestones ORDER BY at, id').all() as Array<{ json: string }>;
  return rows.map((r) => JSON.parse(r.json) as Milestone);
}

/** The row as it leaves the engine: its copy redacted and plain. */
function clean(m: Milestone): Milestone {
  return { ...m, title: plain(m.title, 120), detail: plain(m.detail, 300) };
}

function write(m: Milestone): void {
  openDb()
    .prepare('INSERT INTO milestones (id, kind, tower_id, at, until, json) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, tower_id = excluded.tower_id, at = excluded.at, until = excluded.until, json = excluded.json')
    .run(m.id, m.kind, m.towerId, m.at, m.until, JSON.stringify(m));
  record('milestone.reached', { milestone: m });
  emit('milestone.reached', { milestone: m });
}

/** Reaches `m` once: a row of its id already written is left as it is. */
function reach(m: Milestone): Milestone {
  const had = loadRow(m.id);
  if (had) return had;
  const row = clean(m);
  write(row);
  return row;
}

/** Writes `p` onto the row `id`, when it changes something, and emits the patched row again. */
function patch(id: string, p: Partial<Milestone>): Milestone | null {
  const cur = loadRow(id);
  if (!cur) return null;
  const next = clean({ ...cur, ...p, id });
  if (JSON.stringify(next) === JSON.stringify(cur)) return cur;
  write(next);
  return next;
}

// ---------------------------------------------------------------- the towers

/** Every tower that stands now, district towers first, by id. */
function standingTowers(): Map<string, TowerSpec> {
  const out = new Map<string, TowerSpec>();
  for (const d of city()) out.set(d.tower.id, d.tower);
  for (const q of quarters()) for (const t of q.towers) out.set(t.id, t);
  return out;
}

interface Names {
  firm: (id: string | null | undefined) => string;
  agent: (id: string | null | undefined) => Agent | null;
  tower: (t: TowerSpec) => string;
}

function names(): Names {
  const firms = new Map(listFirms().map((f) => [f.id, f.name]));
  const agents = new Map(listAgents().map((a) => [a.id, a]));
  const firm = (id: string | null | undefined) => (id ? (firms.get(id) ?? id) : 'A firm');
  const agent = (id: string | null | undefined) => (id ? (agents.get(id) ?? null) : null);
  return {
    firm,
    agent,
    tower: (t) => (t.kind === 'agent' ? `the tower of ${agent(t.agentId)?.name ?? t.agentId ?? 'an agent'}` : shortName(t.repo)),
  };
}

const earnedHeight = (t: TowerSpec) => {
  const l = layoutTower(t);
  return l.top - l.datumY;
};
const hasLit = (t: TowerSpec) => t.floors.some((f) => f.earned?.state === 'lit');
/** The newest lit floor of a tower, by its time. */
function newestLit(t: TowerSpec): Floor | null {
  return t.floors.filter((f) => f.earned?.state === 'lit').sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}

/**
 * The two skylines over the towers that stand now. The lit spire: the
 * greatest earned height above the datum among towers with a lit earned
 * floor; the holder keeps a tie, and among level newcomers a district tower
 * ranks before an agent's. The founding skyline: the greatest total height,
 * never lit, its row ended when it passes.
 */
function settleSkylines(now: number, cause?: { towerId: string; floorId: string | null; at: string | null }): void {
  const towers = standingTowers();
  const n = names();
  const rows = allRows();

  // The lit spire.
  let best: { t: TowerSpec; h: number } | null = null;
  for (const t of towers.values()) {
    if (!hasLit(t)) continue;
    const h = earnedHeight(t);
    if (h <= 0) continue;
    if (!best || h > best.h) best = { t, h };
  }
  const holder = rows.find((m) => m.kind === 'skyline' && m.lit) ?? null;
  if (best) {
    const held = holder ? towers.get(holder.towerId) : undefined;
    const stays = held && hasLit(held) && earnedHeight(held) >= best.h;
    if (!stays && best.t.id !== holder?.towerId) {
      if (holder) patch(holder.id, { lit: false });
      const t = best.t;
      const floor = cause && cause.towerId === t.id && cause.floorId ? (t.floors.find((f) => f.id === cause.floorId) ?? null) : newestLit(t);
      const at = floor?.at ?? cause?.at ?? iso(now);
      const m: Milestone = {
        id: `skyline:${t.id}`,
        kind: 'skyline',
        towerId: t.id,
        repo: t.kind === 'agent' ? null : t.repo,
        firmId: t.firmId ?? floor?.earned?.firmId ?? null,
        agentId: t.agentId ?? null,
        floorId: floor?.id ?? null,
        at,
        until: null,
        lit: true,
        title: 'The skyline',
        detail: `${n.tower(t)} stands tallest above its datum.`,
      };
      if (loadRow(m.id)) patch(m.id, m);
      else reach(m);
    }
  }

  // The founding skyline.
  let tallest: { t: TowerSpec; h: number } | null = null;
  for (const t of towers.values()) {
    const h = layoutTower(t).top;
    if (!tallest || h > tallest.h) tallest = { t, h };
  }
  const finial = rows.find((m) => m.kind === 'founding-skyline' && m.until === null) ?? null;
  if (tallest) {
    const held = finial ? towers.get(finial.towerId) : undefined;
    const stays = held && layoutTower(held).top >= tallest.h;
    if (!stays && tallest.t.id !== finial?.towerId) {
      if (finial) patch(finial.id, { until: iso(now) });
      const t = tallest.t;
      const m: Milestone = {
        id: `founding-skyline:${t.id}`,
        kind: 'founding-skyline',
        towerId: t.id,
        repo: t.kind === 'agent' ? null : t.repo,
        firmId: t.firmId ?? null,
        agentId: t.agentId ?? null,
        floorId: null,
        at: iso(now),
        until: null,
        lit: false,
        title: 'The founding skyline',
        detail: `${n.tower(t)} is the tallest tower in the city.`,
      };
      if (loadRow(m.id)) patch(m.id, m);
      else reach(m);
    }
  }
}

// ---------------------------------------------------------------- revival and ribbon

/**
 * The newest time of any other floor the tower had before `floor`, in ms,
 * or null when it is the first. A waiting floor is a PR not yet merged, not
 * a floor the repo had, so an older PR merging while newer ones still wait
 * is still the first floor after a quiet spell.
 */
function previousFloorAt(t: TowerSpec, floor: Floor): number | null {
  let prev: number | null = null;
  for (const f of t.floors) {
    if (f.id === floor.id || f.at >= floor.at || f.earned?.state === 'waiting') continue;
    const ms = Date.parse(f.at);
    if (Number.isFinite(ms) && (prev === null || ms > prev)) prev = ms;
  }
  return prev;
}

/** A lit floor on a district tower quiet `QUIET_DAYS` or more revives it: lights for `LIGHTS_DAYS`. */
function reachRevival(t: TowerSpec, floor: Floor): void {
  const prev = previousFloorAt(t, floor);
  if (prev === null) return;
  const litAt = Date.parse(floor.at);
  const days = Math.floor((litAt - prev) / DAY_MS);
  if (days < QUIET_DAYS) return;
  reach({
    id: `revival:${floor.id}`,
    kind: 'revival',
    towerId: t.id,
    repo: t.repo,
    firmId: floor.earned?.firmId ?? null,
    agentId: floor.earned?.agentId ?? null,
    floorId: floor.id,
    at: floor.at,
    until: iso(litAt + LIGHTS_DAYS * DAY_MS),
    lit: true,
    title: 'Back to life',
    detail: `The first floor on ${t.repo} in ${days} days. The lights stay a week.`,
  });
}

/** Every earned floor on a district tower, with its tower id. */
function districtEarned(): Array<{ towerId: string; floor: Floor }> {
  const rows = openDb().prepare("SELECT tower_id, json FROM earned_floors WHERE tower_id LIKE '%#founding' ORDER BY seq").all() as Array<{ tower_id: string; json: string }>;
  return rows.map((r) => ({ towerId: r.tower_id, floor: JSON.parse(r.json) as Floor }));
}

function ribbonId(firmId: string, jobId: string): string {
  return `ribbon:${firmId}:${jobId}`;
}

/** A waiting floor on a district tower that is its firm's first PR gets the ribbon; `until` is set when it lights, closes or the firm folds. */
function reachRibbon(towerId: string, floor: Floor, n: Names, o: { until?: string | null } = {}): void {
  const e = floor.earned;
  if (!e || !districtTower(towerId)) return;
  if (loadRow(ribbonId(e.firmId, e.jobId))) return;
  const rows = allRows();
  if (rows.some((m) => m.kind === 'ribbon' && m.firmId === e.firmId)) return;
  // A scar is a failed inspection, never a PR, so it does not make a firm's first PR its second.
  const earlier = districtEarned().some(({ floor: f }) => f.earned && f.earned.firmId === e.firmId && f.earned.jobId !== e.jobId && f.earned.state !== 'scar' && f.at < floor.at);
  if (earlier) return;
  const firm = n.firm(e.firmId);
  reach({
    id: ribbonId(e.firmId, e.jobId),
    kind: 'ribbon',
    towerId,
    repo: floor.repo,
    firmId: e.firmId,
    agentId: e.agentId,
    floorId: floor.id,
    at: floor.at,
    until: o.until ?? null,
    lit: true,
    title: `The first PR of ${firm}`,
    detail: `${firm}'s first floor, on ${floor.repo}. The ribbon comes down a week after it merges.`,
  });
}

/** Ends every ribbon that `keep` picks at `at`, unless it already ended by then. */
function endRibbons(keep: (m: Milestone) => boolean, at: string): void {
  for (const m of allRows()) {
    if (m.kind !== 'ribbon' || !keep(m)) continue;
    if (m.until !== null && m.until <= at) continue;
    patch(m.id, { until: at });
  }
}

// ---------------------------------------------------------------- the bus

function floorOf(towerId: string, floorId: string | undefined, given: Floor | undefined): Floor | null {
  if (given?.id) return given;
  if (!floorId) return null;
  return earnedFloors(towerId).find((f) => f.id === floorId) ?? null;
}

function onLaid(d: { towerId: string; floor: Floor }): void {
  if (!d.towerId || !d.floor?.earned || d.floor.earned.state !== 'waiting') return;
  reachRibbon(d.towerId, d.floor, names());
}

function onLit(d: { towerId: string; floorId?: string; floor?: Floor }, now: number): void {
  const floor = floorOf(d.towerId, d.floorId, d.floor);
  if (floor && districtTower(d.towerId)) {
    const t = loadTower(floor.repo);
    if (t) reachRevival(t, floor);
    const litAt = floor.at;
    for (const m of allRows()) {
      if (m.kind === 'ribbon' && m.floorId === floor.id && m.until === null) patch(m.id, { until: iso(Date.parse(litAt) + RIBBON_DAYS * DAY_MS) });
    }
  }
  settleSkylines(now, { towerId: d.towerId, floorId: floor?.id ?? d.floorId ?? null, at: floor?.at ?? null });
}

function handle(e: Event, now: number): void {
  const d = e.data as Record<string, unknown>;
  switch (e.type) {
    case 'floor.laid':
      onLaid(d as { towerId: string; floor: Floor });
      return;
    case 'floor.lit':
      onLit(d as { towerId: string; floorId?: string; floor?: Floor }, now);
      return;
    case 'job.changed': {
      const j = d.job as Job | undefined;
      if (j?.status === 'closed' && j.id) endRibbons((m) => m.firmId !== null && m.id === ribbonId(m.firmId, j.id), iso(now));
      return;
    }
    case 'firm.bankrupt': {
      const firmId = typeof d.firmId === 'string' ? d.firmId : null;
      if (!firmId) return;
      const at = typeof d.at === 'string' && Number.isFinite(Date.parse(d.at)) ? d.at : iso(now);
      endRibbons((m) => m.firmId === firmId, at);
      return;
    }
    case 'repo.analyzed':
    case 'repo.disconnected':
    case 'floor.removed':
    case 'merge.reverted':
      settleSkylines(now);
      return;
    default:
      return;
  }
}

/**
 * Listens to the bus for the floors, the jobs, the firms and the repos and
 * reaches, patches or ends milestones as they move. Returns the unsubscribe.
 * A failure in one event is logged and never reaches the emitter.
 */
export function installMilestones(o: { now?: () => number } = {}): () => void {
  const now = o.now ?? (() => Date.now());
  return subscribe((e) => {
    try {
      handle(e, now());
    } catch (err) {
      console.error(`palimpsest: milestones failed on ${e.type}:`, err);
    }
  });
}

/**
 * Reaches, once, every milestone the towers already hold (an engine from
 * before milestones, or a sample home): the two skylines, each revival the
 * floors show, and each firm's first PR floor. Idempotent by id.
 */
export function backfillMilestones(now: number = Date.now()): void {
  const n = names();
  settleSkylines(now);
  const bankruptAt = new Map(listFirms().filter((f) => f.status === 'bankrupt' && f.bankruptAt).map((f) => [f.id, f.bankruptAt as string]));
  const firstByFirm = new Map<string, { towerId: string; floor: Floor }>();
  for (const d of city()) {
    const t = d.tower;
    for (const f of t.floors) if (f.earned?.state === 'lit') reachRevival(t, f);
    for (const f of earnedFloors(t.id)) {
      const e = f.earned;
      if (!e || e.state === 'scar') continue;
      const cur = firstByFirm.get(e.firmId);
      if (!cur || f.at < cur.floor.at) firstByFirm.set(e.firmId, { towerId: t.id, floor: f });
    }
  }
  for (const [firmId, { towerId, floor }] of firstByFirm) {
    const e = floor.earned!;
    let until: string | null = e.state === 'lit' ? iso(Date.parse(floor.at) + RIBBON_DAYS * DAY_MS) : null;
    const folded = bankruptAt.get(firmId);
    if (folded && (until === null || folded < until)) until = folded;
    reachRibbon(towerId, floor, n, { until });
  }
}

/** The milestones on towers that stand now, oldest first; `active` keeps the ones not yet ended at `now`. */
export function listMilestones(now: number = Date.now(), o: { active?: boolean } = {}): Milestone[] {
  const towers = standingTowers();
  return allRows().filter((m) => towers.has(m.towerId) && (!o.active || m.until === null || Date.parse(m.until) > now));
}

/** Every milestone ever reached on one tower, ended or not, oldest first. */
export function milestonesOf(towerId: string): Milestone[] {
  const rows = openDb().prepare('SELECT json FROM milestones WHERE tower_id = ? ORDER BY at, id').all(towerId) as Array<{ json: string }>;
  return rows.map((r) => JSON.parse(r.json) as Milestone);
}

// ---------------------------------------------------------------- the week tour

/**
 * The tour of the week that holds `now` (a time, or a Monday's key as the
 * brief offers it): merged floors, scars, milestones, each firm's first job
 * and each hire from the ledger, over the towers that stand now.
 */
export function weekTour(now: number | string = Date.now()): Tour | null {
  const w = weekOf(now);
  const towers = standingTowers();
  const n = names();
  const events: TourEvent[] = [];
  const floorNo = (t: TowerSpec, floorId: string) => {
    const i = t.floors.findIndex((f) => f.id === floorId);
    return i < 0 ? null : i + 1;
  };

  for (const e of query({ kind: 'floor.lit', from: w.from, to: w.to })) {
    const d = e.data as { towerId: string; floorId?: string; floor?: Floor };
    if (!districtTower(d.towerId)) continue;
    const t = towers.get(d.towerId);
    const f = d.floor ?? t?.floors.find((x) => x.id === d.floorId);
    if (!t || !f?.earned) continue;
    const no = floorNo(t, f.id);
    events.push({ kind: 'merged', at: f.at ?? e.at, towerId: t.id, floorId: f.id, agentId: f.earned.agentId, firmId: f.earned.firmId, repo: t.repo, title: `${n.firm(f.earned.firmId)} laid ${no ? `floor ${no}` : 'a floor'} on ${shortName(t.repo)}` });
  }
  for (const e of query({ kind: 'floor.scarred', from: w.from, to: w.to })) {
    const d = e.data as { towerId: string; floor: Floor };
    const t = towers.get(d.towerId);
    if (!t || !d.floor?.earned) continue;
    events.push({ kind: 'scar', at: d.floor.at ?? e.at, towerId: t.id, floorId: d.floor.id, agentId: d.floor.earned.agentId, firmId: d.floor.earned.firmId, repo: t.repo, title: `${n.firm(d.floor.earned.firmId)} left a scar on ${shortName(t.repo)}` });
  }
  for (const e of query({ kind: 'milestone.reached', from: w.from, to: w.to })) {
    const m = (e.data as { milestone?: Milestone }).milestone;
    if (!m?.id) continue;
    const t = towers.get(m.towerId);
    if (!t) continue;
    const base = { at: m.at, towerId: m.towerId, floorId: m.floorId, agentId: m.agentId, firmId: m.firmId, repo: m.repo };
    if (m.kind === 'skyline' && m.lit) events.push({ ...base, kind: 'skyline', title: `The skyline passed to ${n.tower(t)}` });
    else if (m.kind === 'revival') events.push({ ...base, kind: 'revival', title: `${shortName(m.repo ?? t.repo)} came back to life` });
    else if (m.kind === 'ribbon') events.push({ ...base, kind: 'ribbon', title: `${n.firm(m.firmId)} laid its first PR floor on ${shortName(m.repo ?? t.repo)}` });
  }
  // A firm's first job: the earliest award it ever won, when that fell in the week.
  const firstAward = new Map<string, { at: string; agentId: string; jobId: string }>();
  for (const e of query({ kind: 'job.awarded' })) {
    const d = e.data as { jobId: string; chosen?: { firmId: string; agentId: string } | null; at?: string };
    if (!d.chosen) continue;
    if (!firstAward.has(d.chosen.firmId)) firstAward.set(d.chosen.firmId, { at: d.at ?? e.at, agentId: d.chosen.agentId, jobId: d.jobId });
  }
  for (const [firmId, a] of firstAward) {
    if (a.at < w.from || a.at >= w.to) continue;
    const j = storedJob(a.jobId);
    events.push({ kind: 'firm', at: a.at, towerId: agentTowerId(a.agentId), floorId: null, agentId: a.agentId, firmId, repo: j?.repo ?? null, title: `${n.firm(firmId)} won its first job${j ? ` on ${shortName(j.repo)}` : ''}` });
  }
  for (const e of query({ kind: 'agent.hired', from: w.from, to: w.to })) {
    const a = (e.data as { agent?: { id: string; firmId: string; name: string } }).agent;
    if (!a?.id) continue;
    events.push({ kind: 'hire', at: e.at, towerId: agentTowerId(a.id), floorId: null, agentId: a.id, firmId: a.firmId, repo: null, title: `${n.firm(a.firmId)} hired ${a.name}` });
  }
  const tour = tourPlan(w, events.map((e) => ({ ...e, title: plain(e.title, 120) })), new Set(towers.keys()));
  if (!tour) return null;
  return { ...tour, stops: tour.stops.map((s) => ({ ...s, caption: plain(s.caption, 160) })) };
}
