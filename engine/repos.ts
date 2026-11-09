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

/** A root architectural style for `fullName`, stable across calls (same name, same style). */
export function pickRoot(fullName: string): RootStyle {
  return ROOTS[fnv1a32(fullName) % ROOTS.length];
}

function loadRepo(fullName: string): Repo | null {
  const db = openDb();
  const row = db.prepare('SELECT json FROM repos WHERE full_name = ?').get(fullName) as
    | { json: string }
    | undefined;
  return row ? (JSON.parse(row.json) as Repo) : null;
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
  const repos = rows.map((row) => JSON.parse(row.json) as Repo);
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
 */
function nextSlot(): number {
  const repos = listRepos();
  if (repos.length === 0) return 0;
  return repos.reduce((max, r) => Math.max(max, r.slot), -1) + 1;
}

/**
 * Stores `fullName` as connected and starts analysis without awaiting it.
 * A repo already analyzing (its first connect still in flight) is returned
 * unchanged, without starting a second analysis. Otherwise (new repo, or
 * reconnecting a previously disconnected one) a fresh analysis starts,
 * refreshing its tower. A new repo is assigned the next unused slot; a
 * reconnecting repo keeps the slot it already had.
 */
export async function connect(fullName: string): Promise<Repo> {
  const existing = loadRepo(fullName);
  if (existing && existing.status === 'analyzing') {
    return existing;
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
      };

  saveRepo(repo);
  record('repo.connected', { repo: fullName });
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
 * Safe to run concurrently for different repos.
 */
export async function analyze(fullName: string): Promise<void> {
  try {
    let repo = loadRepo(fullName);
    if (!repo) {
      throw new Error(`analyze: ${fullName} has not been connected`);
    }

    emit('repo.analyzing', { repo, step: 'mirror' });
    const meta = await repoMeta(fullName);
    repo = saveRepo({ ...repo, ...meta });
    const dir = await syncMirror(fullName);

    emit('repo.analyzing', { repo, step: 'log' });
    const commits = await readLog(dir, repo.defaultBranch);

    emit('repo.analyzing', { repo, step: 'prs' });
    const prs = await mergedPRs(fullName);

    emit('repo.analyzing', { repo, step: 'floors' });
    const floors = foundingFloors(fullName, commits, prs);

    const tower: TowerSpec = {
      id: `${fullName}#founding`,
      repo: fullName,
      kind: 'founding',
      root: repo.root,
      floors,
      datumIndex: floors.length,
    };
    saveTower(tower);

    repo = saveRepo({ ...repo, status: 'ready', error: null, analyzedAt: new Date().toISOString() });
    emit('repo.analyzed', { repo });
    record('repo.analyzed', { repo: fullName, floors: floors.length });
  } catch (err) {
    const message = err instanceof GhError ? err.message : readableMessage(err);
    // Guarded: loadRepo/saveRepo/emit/record can themselves throw (a closed
    // db handle, a bad write), and this is already the error path. Letting
    // that escape would leave the repo stuck at 'analyzing' forever and
    // reject analyze()'s own promise, which is called without awaiting it.
    try {
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

/** Marks `fullName` as disconnected. Its tower is kept so reconnecting can skip straight to a fresh analysis. */
export function disconnect(fullName: string): void {
  const repo = loadRepo(fullName);
  if (!repo) return;
  saveRepo({ ...repo, connected: false });
  record('repo.disconnected', { repo: fullName });
}

/** Merges `p` into the stored repo's pushMode/root. */
export function patchRepo(fullName: string, p: Partial<Pick<Repo, 'pushMode' | 'root'>>): Repo {
  const repo = loadRepo(fullName);
  if (!repo) {
    throw new Error(`patchRepo: ${fullName} has not been connected`);
  }
  const updated = saveRepo({ ...repo, ...p });
  record('repo.patched', { repo: fullName, patch: p });
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
