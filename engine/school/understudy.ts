/**
 * The Understudy reader (Phase 4 Task 10, ruling 10, Decision 9). Understudy
 * is his own app; its database holds his taste statements and the
 * calibration pairs he picked between. The school reads it, never writes it.
 *
 * - Nothing is read unless `school.understudy` is on: every function checks
 *   the switch before it even resolves the path.
 * - The database is opened read only (`node:sqlite` `readOnly: true`). When
 *   the first read fails on a WAL database (its `-shm` cannot be created
 *   beside it), it is opened again as `file:<path>?immutable=1`, still read
 *   only. Any write through either handle throws.
 * - Under a test only `PALIMPSEST_UNDERSTUDY_DB` is opened; an unset value or
 *   one inside Understudy's real folder, however it is spelled, throws the
 *   way `home()` does (test safety rule 12).
 * - Statements are those not removed; pairs are those he answered with `a`
 *   or `b` (no pick and `neither` are skipped).
 * - A pair is scored once by the local vision judge under a local school
 *   lease, charged to the city, and the two scores are cached under
 *   `paths().school/understudy`. The shots are read in place, only from
 *   inside Understudy's own folder, and never copied anywhere.
 */
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

import { designBar, VISION_JUDGE } from '../guild/design.js';
import { paths } from '../home.js';
import { acquire, charge, JUDGE_ESTIMATE, unattended } from '../market/budget.js';
import { providerFor } from '../market/providers.js';
import { getSettings } from '../settings.js';
import type { UnderstudyCounts, UnderstudyPair } from './datasets.js';

/** Understudy's own folder (its `paths.home`). */
export function understudyHome(): string {
  return join(homedir(), 'Library', 'Application Support', 'Understudy');
}

/** Where Understudy keeps its database when nothing moves it. */
export function defaultUnderstudyDb(): string {
  return join(understudyHome(), 'understudy.db');
}

/** True inside a `node --test` process, as `home()` decides it. */
function underTest(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.NODE_TEST_CONTEXT) || (env === process.env && process.execArgv.includes('--test'));
}

/** The real path of a path's deepest existing ancestor, lowercased (the Mac's volume ignores case). */
function canonical(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync.native(abs).toLowerCase();
  const parent = dirname(abs);
  if (parent === abs) return abs.toLowerCase();
  return join(canonical(parent), basename(abs).toLowerCase());
}

const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/**
 * True when `p` lies in Understudy's real folder. The spelling is checked
 * first without touching the disk; only then is `p` itself resolved, against
 * the real home folder, so the check never stats anything of Understudy's.
 */
function inRealFolder(p: string): boolean {
  const real = understudyHome();
  if (within(resolve(p).toLowerCase(), real.toLowerCase())) return true;
  const viaHome = join(canonical(homedir()), 'library', 'application support', 'understudy');
  return within(canonical(p), viaHome);
}

/**
 * The database the reader opens: `PALIMPSEST_UNDERSTUDY_DB`, else
 * Understudy's default. Under a test it must be set and must not be inside
 * Understudy's real folder, or this throws.
 */
export function understudyPath(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.PALIMPSEST_UNDERSTUDY_DB || '';
  if (underTest(env)) {
    if (!set) throw new Error('refused: a test reached Understudy\'s real database (PALIMPSEST_UNDERSTUDY_DB is unset)');
    if (inRealFolder(set)) throw new Error('refused: a test reached Understudy\'s real database (PALIMPSEST_UNDERSTUDY_DB is in its real folder)');
  }
  return set || defaultUnderstudyDb();
}

/** Whether he said the school may read Understudy. */
function switchedOn(): boolean {
  return getSettings().school.understudy === true;
}

/** True when the file's header says WAL (bytes 18 and 19 are 2). */
function isWal(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY);
    const head = Buffer.alloc(20);
    return readSync(fd, head, 0, 20, 0) === 20 && head[18] === 2 && head[19] === 2;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Opens `path` read only and proves it can be read; a WAL file that cannot be read that way opens immutable. */
function openReadOnly(path: string): DatabaseSync {
  const probe = (db: DatabaseSync) => {
    try {
      db.prepare('select count(*) from sqlite_master').get();
      return db;
    } catch (err) {
      db.close();
      throw err;
    }
  };
  try {
    return probe(new DatabaseSync(path, { readOnly: true }));
  } catch (err) {
    if (!isWal(path)) throw err;
    return probe(new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true }));
  }
}

/**
 * A read-only handle on Understudy's database, which the caller closes; null
 * while the switch is off or when there is no database. Never creates one.
 */
export function understudyDb(): DatabaseSync | null {
  if (!switchedOn()) return null;
  const path = understudyPath();
  if (!existsSync(path)) return null;
  return openReadOnly(path);
}

/** Runs `read` on a fresh handle and closes it; `empty` while off, missing or unreadable. A refused path still throws. */
function reading<T>(empty: T, read: (db: DatabaseSync) => T): T {
  if (!switchedOn()) return empty;
  const path = understudyPath();
  if (!existsSync(path)) return empty;
  let db: DatabaseSync | null = null;
  try {
    db = openReadOnly(path);
    return read(db);
  } catch {
    return empty;
  } finally {
    db?.close();
  }
}

function statementsFrom(db: DatabaseSync): string[] {
  const rows = db.prepare('select text from statements where removed = 0 order by weight desc, id').all() as Array<{ text: unknown }>;
  return rows.flatMap((r) => (typeof r.text === 'string' && r.text.trim() ? [r.text.trim()] : []));
}

/** His taste statements, strongest first, without the ones he removed; empty while the switch is off. */
export function understudyStatements(): string[] {
  return reading([], statementsFrom);
}

/** The pairs he answered with `a` or `b`, oldest first, with their cached scores; empty while the switch is off. */
export function understudyPairs(): UnderstudyPair[] {
  return reading([] as UnderstudyPair[], (db) => {
    const cache = readCache();
    const rows = db.prepare("select id, at, pick from pairs where pick in ('a', 'b') order by at, id").all() as Array<{ id: string; at: string; pick: 'a' | 'b' }>;
    return rows.map((r) => {
      const s = cache[r.id];
      return { id: r.id, at: r.at, pick: r.pick, scores: s ? { a: s.a, b: s.b } : null };
    });
  });
}

/** Live statements, all pairs, and answered pairs; null while the switch is off or there is no database. */
export function understudyCounts(): UnderstudyCounts | null {
  return reading<UnderstudyCounts | null>(null, (db) => {
    const n = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
    return {
      statements: n('select count(*) n from statements where removed = 0'),
      pairs: n('select count(*) n from pairs'),
      answered: n("select count(*) n from pairs where pick in ('a', 'b')"),
    };
  });
}

// ---------------------------------------------------------------- scoring a pair

interface Cached {
  a: number;
  b: number;
  at: string;
}

function cacheFile(): string {
  return join(paths().school, 'understudy', 'scores.json');
}

function readCache(): Record<string, Cached> {
  try {
    const raw = JSON.parse(readFileSync(cacheFile(), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, Cached> = {};
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      const c = v as Partial<Cached> | null;
      if (c && Number.isFinite(c.a) && Number.isFinite(c.b)) out[id] = { a: c.a as number, b: c.b as number, at: String(c.at ?? '') };
    }
    return out;
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, Cached>): void {
  const file = cacheFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, file);
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SHOT_BYTES = 20 * 1024 * 1024;

/** A pair's shot, read in place: a regular PNG file inside `folder`, not too large; null otherwise. */
function readShotIn(path: unknown, folder: string): Buffer | null {
  if (typeof path !== 'string' || !path) return null;
  let fd: number | undefined;
  try {
    const real = realpathSync.native(path);
    if (!within(real, realpathSync.native(folder))) return null;
    fd = openSync(real, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_SHOT_BYTES || st.size < PNG_MAGIC.length) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    const bytes = buf.subarray(0, off);
    return bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) ? bytes : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

interface PairRow {
  dimension: string;
  question: string;
  a_label: string;
  b_label: string;
  a_shot: string;
  b_shot: string;
}

/**
 * The local vision judge's two scores for an answered pair, A then B, each
 * 0 to 10 against his bar and statements. Scored once under a local school
 * lease (charged `school` to the city) and cached; null while the switch is
 * off, when the pair or its shots cannot be read, when no lease is granted,
 * or when the judge cannot score both sides.
 */
export async function scorePair(pair: Pick<UnderstudyPair, 'id'>, o: { now?: number; waitUntil?: number } = {}): Promise<{ a: number; b: number } | null> {
  if (!switchedOn()) return null;
  const cached = readCache()[pair.id];
  if (cached) return { a: cached.a, b: cached.b };

  const path = understudyPath();
  const found = reading<{ row: PairRow; bible: string[] } | null>(null, (db) => {
    const row = db
      .prepare("select dimension, question, a_label, b_label, a_shot, b_shot from pairs where id = ? and pick in ('a', 'b')")
      .get(pair.id) as PairRow | undefined;
    return row ? { row, bible: statementsFrom(db) } : null;
  });
  if (!found) return null;
  const folder = dirname(path);
  const a = readShotIn(found.row.a_shot, folder);
  const b = readShotIn(found.row.b_shot, folder);
  if (!a || !b) return null;

  const got = await acquire(VISION_JUDGE, 'school', JUDGE_ESTIMATE, { now: o.now, waitUntil: o.waitUntil });
  if (!got.ok) return null;
  const lease = got.lease;
  const r = found.row;
  const clip = (s: unknown, n: number) => String(s ?? '').slice(0, n);
  const text = [
    `This is not a change: it is one page rendered two ways that differ only in ${clip(r.dimension, 200)}.`,
    `The "before" screenshot is version A (${clip(r.a_label, 200)}) and the "after" screenshot is version B (${clip(r.b_label, 200)}).`,
    `The question asked: ${clip(r.question, 500)}`,
    'Score each version against the bar on its own.',
  ].join('\n');
  try {
    const provider = providerFor(VISION_JUDGE);
    const out = await provider.judge({ bar: designBar(), bible: found.bible, before: [a.toString('base64')], after: [b.toString('base64')], diff: text }, lease.signal);
    try {
      charge({ runId: null, firmId: null, model: VISION_JUDGE, kind: 'school', usage: out.usage, unattended: unattended(o.now), lease });
    } catch {
      // A charge that cannot be written leaves the score unrecorded rather than free.
      return null;
    }
    const clamp = (x: number) => Math.max(0, Math.min(10, x));
    if (typeof out.before !== 'number' || !Number.isFinite(out.before) || typeof out.after !== 'number' || !Number.isFinite(out.after)) return null;
    const scores = { a: clamp(out.before), b: clamp(out.after) };
    writeCache({ ...readCache(), [pair.id]: { ...scores, at: new Date(o.now ?? Date.now()).toISOString() } });
    return scores;
  } catch {
    return null;
  } finally {
    lease.release();
  }
}
