import { repoMarketDefaults } from '../shared/market-rules.js';
import type { District, Repo, RootStyle, TowerSpec } from '../shared/types.js';
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

  let next = repos.reduce((max, r) => (hasValidSlot(r) ? Math.max(max, r.slot) : max), -1) + 1;

  const bySlot = new Map<string, number>();
  const missingByConnectedAt = [...missing].sort((a, b) => {
    const at = a.connectedAt ? Date.parse(a.connectedAt) : 0;
    const bt = b.connectedAt ? Date.parse(b.connectedAt) : 0;
    return at - bt;
  });
  for (const r of missingByConnectedAt) {
    bySlot.set(r.fullName, next);
    next += 1;
  }

  return repos.map((r) => {
    const slot = bySlot.get(r.fullName);
    if (slot === undefined) return r;
    const fixed = { ...r, slot };
    saveRepo(fixed);
    return fixed;
  });
}

/** A stored repo row, with the market defaults filled in for any field a pre-Phase 2 writer left out. */
function parseRepo(json: string): Repo {
  const stored = JSON.parse(json) as Partial<Repo>;
  const joinedAt = stored.joinedAt !== undefined ? stored.joinedAt : (stored.analyzedAt ?? null);
  return { ...repoMarketDefaults(), ...stored, joinedAt } as Repo;
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

function loadTower(repo: string): TowerSpec | null {
  const db = openDb();
  const row = db.prepare('SELECT json FROM towers WHERE repo = ?').get(repo) as { json: string } | undefined;
  return row ? (JSON.parse(row.json) as TowerSpec) : null;
}

function saveTower(tower: TowerSpec): void {
  const db = openDb();
  db.prepare(
    'INSERT INTO towers (repo, json) VALUES (?, ?) ON CONFLICT(repo) DO UPDATE SET json = excluded.json',
  ).run(tower.repo, JSON.stringify(tower));
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
 * The next unused slot: one past the highest slot assigned so far across
 * every stored repo (connected or not), starting at 0. A slot is assigned
 * once, at a repo's first connect, and is never reused, so a repo's district
 * position is stable for the repo's whole lifetime in the city regardless of
 * how many other repos connect, disconnect or reconnect around it.
 *
 * listRepos() already backfills any row missing a finite slot before this
 * runs, so in practice every row here has one; the Number.isFinite guard is
 * a second, cheap line of defense against ever folding a NaN/undefined
 * slot into the max (which would poison every later slot with NaN).
 */
function nextSlot(): number {
  const repos = listRepos();
  if (repos.length === 0) return 0;
  return repos.reduce((max, r) => (Number.isFinite(r.slot) ? Math.max(max, r.slot) : max), -1) + 1;
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
        slot: nextSlot(),
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
    const floors = foundingFloors(fullName, commits, prs);

    const tower: TowerSpec = {
      id: `${fullName}#founding`,
      repo: fullName,
      kind: 'founding',
      root: loadRepo(fullName)?.root ?? repo.root,
      floors,
      datumIndex: floors.length,
    };
    saveTower(tower);

    repo = saveRepo({ ...(loadRepo(fullName) ?? repo), status: 'ready', error: null, analyzedAt: new Date().toISOString() });
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
    const tower = loadTower(fullName);
    if (tower && tower.root !== p.root) saveTower({ ...tower, root: p.root });
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
