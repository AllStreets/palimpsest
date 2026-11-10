import { repoMarketDefaults } from '../shared/market-rules.js';
import type { District, Floor, Repo, RootStyle, TowerSpec } from '../shared/types.js';
import { openDb } from './db.js';
import { emit } from './events.js';
import { GhError, mergedPRs, repoMeta } from './github.js';
import { foundingFloors } from './history.js';
import { districtOrigin } from './layout.js';
import { record } from './ledger.js';
import { readLog, syncMirror } from './mirror.js';

const ROOTS: RootStyle[] = ['beauxarts', 'roman', 'gothic', 'pagoda', 'chicago'];

/** 32-bit FNV-1a hash, used only to pick a deterministic root style per repo name. */
function fnv1a32(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** One owner or name segment as GitHub allows it: letters, digits, '.', '_' and '-', never a leading '-'. */
const SEGMENT = /^(?!-)[A-Za-z0-9_.-]+$/;

/** The message for a name that is not owner/name. */
export const BAD_NAME = 'Expected owner/name, each made of letters, digits, ".", "_" or "-", not starting with "-".';

/**
 * True when `fullName` is exactly owner/name with each segment safe to hand
 * to gh and git as an argument and to use in a mirror's file name ('.' and
 * '..' are refused, as are a leading '-' that gh would read as a flag).
 */
export function isValidFullName(fullName: string): boolean {
  const parts = fullName.split('/');
  return parts.length === 2 && parts.every((p) => SEGMENT.test(p) && p !== '.' && p !== '..');
}

/** A root architectural style for `fullName`, stable across calls (same name, same style). */
export function pickRoot(fullName: string): RootStyle {
  return ROOTS[fnv1a32(fullName) % ROOTS.length];
}

/** True for a usable slot: a finite number, never NaN/undefined/Infinity. */
function hasValidSlot(repo: Repo): boolean {
  return typeof repo.slot === 'number' && Number.isFinite(repo.slot);
}

/**
 * Backfills a slot onto every row in `repos` that lacks a finite numeric one
 * (rows written before `Repo` gained the field), persisting the fix, and
 * returns the full list with every row now slot-complete. Rows needing a
 * slot are assigned the next unused one each, in `connectedAt` order, never
 * disturbing a row that already has a valid slot.
 */
function ensureSlots(repos: Repo[]): Repo[] {
  const missing = repos.filter((r) => !hasValidSlot(r));
  if (missing.length === 0) return repos;

  const bySlot = new Map<string, number>();
  const missingByConnectedAt = [...missing].sort((a, b) => {
    const at = a.connectedAt ? Date.parse(a.connectedAt) : 0;
    const bt = b.connectedAt ? Date.parse(b.connectedAt) : 0;
    return at - bt;
  });
  // Slots come from the table repos share with firms, so a backfilled repo never lands on a firm's plot.
  for (const r of missingByConnectedAt) bySlot.set(r.fullName, nextSlot('repo', r.fullName));

  return repos.map((r) => {
    const slot = bySlot.get(r.fullName);
    if (slot === undefined) return r;
    const fixed = { ...r, slot };
    saveRepo(fixed);
    return fixed;
  });
}

/**
 * A stored repo row, with the market defaults filled in for any field a
 * pre-Phase 2 writer left out. `joinedAt` is never derived here: migrate()
 * backfilled it for old rows and runAnalysis() writes it at the first success.
 */
function parseRepo(json: string): Repo {
  const stored = JSON.parse(json) as Partial<Repo>;
  return { ...repoMarketDefaults(), ...stored } as Repo;
}

function loadRepo(fullName: string): Repo | null {
  const db = openDb();
  const row = db.prepare('SELECT json FROM repos WHERE full_name = ?').get(fullName) as
    | { json: string }
    | undefined;
  if (!row) return null;
  const repo = parseRepo(row.json);
  if (hasValidSlot(repo)) return repo;
  // This row predates the slot field (or another process wrote it without
  // one). Assigning it a slot in isolation would ignore any other row that
  // also needs one, so backfill every row that needs one in one pass, in
  // connectedAt order, via listRepos(), then return this row's fixed copy.
  return listRepos().find((r) => r.fullName === fullName) ?? repo;
}

function saveRepo(repo: Repo): Repo {
  const db = openDb();
  db.prepare(
    'INSERT INTO repos (full_name, json) VALUES (?, ?) ON CONFLICT(full_name) DO UPDATE SET json = excluded.json',
  ).run(repo.fullName, JSON.stringify(repo));
  return repo;
}

/** The stored founding tower: the floors below the datum only, as the last successful analysis wrote them. */
function loadFoundingTower(repo: string): TowerSpec | null {
  const db = openDb();
  const row = db.prepare('SELECT json FROM towers WHERE repo = ?').get(repo) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as TowerSpec) : null;
}

/** Writes the founding tower. Only founding floors are ever stored here; earned floors live in `earned_floors`. */
function saveFoundingTower(tower: TowerSpec): void {
  const db = openDb();
  db.prepare(
    'INSERT INTO towers (repo, json) VALUES (?, ?) ON CONFLICT(repo) DO UPDATE SET json = excluded.json',
  ).run(tower.repo, JSON.stringify(tower));
}

/** The floors earned in the market on tower `towerId`, in the order they were laid. */
export function earnedFloors(towerId: string): Floor[] {
  const rows = openDb()
    .prepare('SELECT json FROM earned_floors WHERE tower_id = ? ORDER BY seq')
    .all(towerId) as Array<{ json: string }>;
  return rows.map((row) => JSON.parse(row.json) as Floor);
}

/**
 * `fullName`'s district tower as the city shows it (ruling 17): the founding
 * floors, then every earned floor in laid order above the datum. `datumIndex`
 * is the founding count, so it never moves when a floor is earned.
 */
export function loadTower(fullName: string): TowerSpec | null {
  const founding = loadFoundingTower(fullName);
  if (!founding) return null;
  return { ...founding, floors: [...founding.floors, ...earnedFloors(founding.id)] };
}

/**
 * Lays `floor` on top of tower `towerId`, above every floor already earned
 * there, and returns it as stored (always `founding: false`). With
 * updateEarnedFloor and removeEarnedFloor, the only writer of `earned_floors`.
 */
export function layEarnedFloor(towerId: string, floor: Floor): Floor {
  const db = openDb();
  const laid: Floor = { ...floor, founding: false };
  const { next } = db
    .prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM earned_floors WHERE tower_id = ?')
    .get(towerId) as { next: number };
  db.prepare('INSERT INTO earned_floors (id, tower_id, seq, json) VALUES (?, ?, ?, ?)').run(
    laid.id,
    towerId,
    next,
    JSON.stringify(laid),
  );
  return laid;
}

/** Merges `patch` into the earned floor `id`, keeping its id, tower and place. Null when there is no such floor. */
export function updateEarnedFloor(id: string, patch: Partial<Omit<Floor, 'id' | 'founding'>>): Floor | null {
  const db = openDb();
  const row = db.prepare('SELECT json FROM earned_floors WHERE id = ?').get(id) as { json: string } | undefined;
  if (!row) return null;
  const updated: Floor = { ...(JSON.parse(row.json) as Floor), ...patch, id, founding: false };
  db.prepare('UPDATE earned_floors SET json = ? WHERE id = ?').run(JSON.stringify(updated), id);
  return updated;
}

/** Removes the earned floor `id`; the floors above it keep their order. */
export function removeEarnedFloor(id: string): void {
  openDb().prepare('DELETE FROM earned_floors WHERE id = ?').run(id);
}

/** Every repo ever connected, connected or not, oldest connectedAt first. */
export function listRepos(): Repo[] {
  const db = openDb();
  const rows = db.prepare('SELECT json FROM repos').all() as Array<{ json: string }>;
  const repos = ensureSlots(rows.map((row) => parseRepo(row.json)));
  return repos.sort((a, b) => {
    const at = a.connectedAt ? Date.parse(a.connectedAt) : 0;
    const bt = b.connectedAt ? Date.parse(b.connectedAt) : 0;
    return at - bt;
  });
}

/** A short, readable message for an analysis failure: never a stack trace. */
function readableMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Copies every stored repo's slot into the `slots` table, keeping each one
 * unchanged. Rows already there are left alone, so this is safe to run on
 * every allocation; it reads the raw rows so it never recurses through listRepos().
 */
function migrateRepoSlots(): void {
  const db = openDb();
  const rows = db.prepare('SELECT full_name, json FROM repos').all() as Array<{ full_name: string; json: string }>;
  const insert = db.prepare("INSERT OR IGNORE INTO slots (kind, owner, slot) VALUES ('repo', ?, ?)");
  for (const row of rows) {
    const slot = (JSON.parse(row.json) as Partial<Repo>).slot;
    if (typeof slot === 'number' && Number.isFinite(slot)) insert.run(row.full_name, slot);
  }
}

/**
 * The plot on the district spiral held by `owner` (a repo's full name or a
 * firm's id). Repos and firms share one numbering: an owner that already
 * holds a slot keeps it, and a new owner takes one past the highest slot ever
 * assigned to anyone, so no plot is reused and nothing already standing ever
 * moves. Existing repo slots are migrated into the table first, unchanged.
 */
export function nextSlot(kind: 'repo' | 'firm', owner: string): number {
  migrateRepoSlots();
  const db = openDb();
  const held = db.prepare('SELECT slot FROM slots WHERE kind = ? AND owner = ?').get(kind, owner) as
    | { slot: number }
    | undefined;
  if (held) return Number(held.slot);
  const top = db.prepare('SELECT MAX(slot) AS top FROM slots').get() as { top: number | null };
  const slot = top.top === null ? 0 : Number(top.top) + 1;
  db.prepare('INSERT INTO slots (kind, owner, slot) VALUES (?, ?, ?)').run(kind, owner, slot);
  return slot;
}

/** Analyses running in this process, by repo. A second call for a repo joins the one already running. */
const running = new Map<string, Promise<void>>();

/**
 * Stores `fullName` as connected and starts analysis without awaiting it.
 * A repo whose analysis is running in this process is returned unchanged,
 * without starting a second analysis. A row stored as 'analyzing' with no
 * analysis running here (the engine stopped part way) is analyzed afresh. Otherwise (new repo, or
 * reconnecting a previously disconnected one) a fresh analysis starts,
 * refreshing its tower. A new repo is assigned the next unused slot; a
 * reconnecting repo keeps the slot it already had.
 */
export async function connect(fullName: string): Promise<Repo> {
  if (!isValidFullName(fullName)) throw new Error(BAD_NAME);
  const existing = loadRepo(fullName);
  if (existing && existing.status === 'analyzing' && running.has(fullName)) {
    // The analysis already running serves this connect too; only the toggle
    // needs restoring when it was turned off meanwhile (on, off, on).
    if (existing.connected) return existing;
    const reconnected = saveRepo({ ...existing, connected: true });
    record('repo.connected', { repo: fullName });
    emit('repo.connected', { repo: reconnected });
    return reconnected;
  }

  const now = new Date().toISOString();
  const repo: Repo = existing
    ? { ...existing, connected: true, status: 'analyzing', error: null, connectedAt: now }
    : {
        fullName,
        private: false,
        defaultBranch: 'main',
        language: null,
        description: null,
        connected: true,
        pushMode: false,
        root: pickRoot(fullName),
        slot: nextSlot('repo', fullName),
        status: 'analyzing',
        error: null,
        connectedAt: now,
        analyzedAt: null,
        ...repoMarketDefaults(),
      };

  saveRepo(repo);
  record('repo.connected', { repo: fullName });
  emit('repo.connected', { repo });
  void analyze(fullName).catch((err) => {
    // analyze() guards its own body and should never reject; this is a last
    // resort so a truly unexpected failure never becomes an unhandled
    // rejection, since this call is intentionally fire-and-forget.
    console.error(`analyze(${fullName}) rejected unexpectedly:`, err);
  });
  return repo;
}

/**
 * Reads `fullName`'s metadata and history and builds its founding tower.
 * Emits `repo.analyzing` at each step, `repo.analyzed` on success, and
 * `repo.error` on failure (status set to 'error' with a readable message).
 * Safe to run concurrently for different repos; a call for a repo already
 * being analyzed returns that analysis rather than starting another.
 */
export function analyze(fullName: string): Promise<void> {
  const inFlight = running.get(fullName);
  if (inFlight) return inFlight;
  const run: Promise<void> = runAnalysis(fullName).finally(() => {
    if (running.get(fullName) === run) running.delete(fullName);
  });
  running.set(fullName, run);
  return run;
}

/** Marks `fullName`'s analysis finished, before its last event goes out, so a connect that event prompts starts afresh. */
function settled(fullName: string): void {
  running.delete(fullName);
}

async function runAnalysis(fullName: string): Promise<void> {
  try {
    let repo = loadRepo(fullName);
    if (!repo) {
      throw new Error(`analyze: ${fullName} has not been connected`);
    }
    // The datum is fixed at join (ruling 17): a re-analysis reads the same
    // window; a first analysis reads up to now and, on success, joins now.
    const joinedAt = repo.joinedAt ?? new Date().toISOString();

    // Each step event carries the repo as stored now, so a toggle changed mid-analysis is never reported stale.
    emit('repo.analyzing', { repo: loadRepo(fullName) ?? repo, step: 'mirror' });
    const meta = await repoMeta(fullName);
    // Re-read before each write: the toggles (connected, pushMode, root) may have changed while gh ran.
    repo = saveRepo({ ...(loadRepo(fullName) ?? repo), ...meta });
    const dir = await syncMirror(fullName);

    emit('repo.analyzing', { repo: loadRepo(fullName) ?? repo, step: 'log' });
    const commits = await readLog(dir, repo.defaultBranch);

    emit('repo.analyzing', { repo: loadRepo(fullName) ?? repo, step: 'prs' });
    const prs = await mergedPRs(fullName);

    emit('repo.analyzing', { repo: loadRepo(fullName) ?? repo, step: 'floors' });
    const floors = foundingFloors(fullName, commits, prs, { until: joinedAt });

    const tower: TowerSpec = {
      id: `${fullName}#founding`,
      repo: fullName,
      kind: 'founding',
      root: loadRepo(fullName)?.root ?? repo.root,
      floors,
      datumIndex: floors.length,
    };

    // The founding tower and the ready repo are written together, so a write
    // that fails part way leaves both as they were. Earned floors are not
    // touched: they stand in their own table above the new founding floors.
    const db = openDb();
    db.exec('BEGIN');
    try {
      saveFoundingTower(tower);
      const current = loadRepo(fullName) ?? repo;
      repo = saveRepo({
        ...current,
        status: 'ready',
        error: null,
        analyzedAt: new Date().toISOString(),
        joinedAt: current.joinedAt ?? joinedAt,
      });
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    settled(fullName);
    emit('repo.analyzed', { repo });
    record('repo.analyzed', { repo: fullName, floors: floors.length });
  } catch (err) {
    const message = err instanceof GhError ? err.message : readableMessage(err);
    // Guarded: loadRepo/saveRepo/emit/record can themselves throw (a closed
    // db handle, a bad write), and this is already the error path. Letting
    // that escape would leave the repo stuck at 'analyzing' forever and
    // reject analyze()'s own promise, which is called without awaiting it.
    try {
      settled(fullName);
      const repo = loadRepo(fullName);
      if (repo) {
        const updated = saveRepo({ ...repo, status: 'error', error: message });
        emit('repo.error', { repo: updated, error: message });
      }
      record('repo.error', { repo: fullName, error: message });
    } catch (innerErr) {
      console.error(`analyze(${fullName}): failed to record error state '${message}':`, innerErr);
    }
  }
}

/**
 * Marks `fullName` as disconnected and emits `repo.disconnected`. Its tower
 * is kept so reconnecting can skip straight to a fresh analysis.
 */
export function disconnect(fullName: string): void {
  const repo = loadRepo(fullName);
  if (!repo) return;
  const updated = saveRepo({ ...repo, connected: false });
  record('repo.disconnected', { repo: fullName });
  emit('repo.disconnected', { repo: updated });
}

/**
 * Merges `p` into the stored repo's pushMode/root and emits `repo.patched`.
 * A new root restyles the standing tower too (the floors are unchanged), so
 * the city shows the choice at once rather than at the next analysis.
 */
export function patchRepo(fullName: string, p: Partial<Pick<Repo, 'pushMode' | 'root'>>): Repo {
  const repo = loadRepo(fullName);
  if (!repo) {
    throw new Error(`patchRepo: ${fullName} has not been connected`);
  }
  const updated = saveRepo({ ...repo, ...p });
  if (p.root) {
    const tower = loadFoundingTower(fullName);
    if (tower && tower.root !== p.root) saveFoundingTower({ ...tower, root: p.root });
  }
  record('repo.patched', { repo: fullName, patch: p });
  emit('repo.patched', { repo: updated });
  return updated;
}

/**
 * The connected districts, ordered by slot. A repo's position (and so its
 * origin) is its own `slot`, assigned once at first connect and never
 * reused: disconnecting or reconnecting a sibling repo never moves it, and
 * reconnecting the repo itself restores its original origin. A repo still
 * analyzing for the first time has no tower yet and so no district.
 */
export function city(): District[] {
  const connected = listRepos()
    .filter((r) => r.connected)
    .sort((a, b) => a.slot - b.slot);
  const districts: District[] = [];

  for (const repo of connected) {
    const tower = loadTower(repo.fullName);
    if (!tower) continue;
    districts.push({ repo: repo.fullName, index: repo.slot, origin: districtOrigin(repo.slot), tower });
  }

  return districts;
}

/** What a repo left analyzing by an engine that stopped (crash, restart, reinstall, reboot) says. */
export const INTERRUPTED = 'The engine stopped during analysis. Retry to analyze it again.';

/**
 * Run once as the engine starts: any repo still stored as 'analyzing' whose
 * analysis is not running in this process was cut off when the last engine
 * stopped. It becomes an error with a Retry, never an analysis that never ends.
 */
export function failInterruptedAnalyses(): void {
  for (const repo of listRepos()) {
    if (repo.status !== 'analyzing' || running.has(repo.fullName)) continue;
    const updated = saveRepo({ ...repo, status: 'error', error: INTERRUPTED });
    record('repo.error', { repo: repo.fullName, error: INTERRUPTED });
    emit('repo.error', { repo: updated, error: INTERRUPTED });
  }
}
