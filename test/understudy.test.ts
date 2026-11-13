/**
 * The Understudy reader (Phase 4 Task 10, ruling 10, test safety rule 12).
 * Every database here is a fixture built from Understudy's schema in a temp
 * dir; the reader opens only `PALIMPSEST_UNDERSTUDY_DB` under a test and
 * refuses the default path, so his real Understudy database is never read.
 */
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { liveLeaseCount } from '../engine/market/budget.js';
import { fakeProvider } from '../engine/market/fake-provider.js';
import type { JudgeInput } from '../engine/market/provider.js';
import { setProvider } from '../engine/market/providers.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { rowsFor, thinCause } from '../engine/school/datasets.js';
import { scorePair, understudyCounts, understudyDb, understudyPairs, understudyPath, understudyStatements } from '../engine/school/understudy.js';
import { PNG } from './guild-fixtures.js';
import { makeUnderstudy, writeShots } from './understudy-fixtures.js';

let tempDir: string;
let saved: Record<string, string | undefined>;
const ENV = ['PALIMPSEST_HOME', 'PALIMPSEST_UNDERSTUDY_DB', 'PALIMPSEST_CLAUDE_PROJECTS', 'PALIMPSEST_TEST_PROJECTS'] as const;

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-understudy-test-'));
  process.env.PALIMPSEST_HOME = join(tempDir, 'home');
  // The caps read Claude's usage from an empty temp projects folder, never his.
  process.env.PALIMPSEST_CLAUDE_PROJECTS = join(tempDir, 'projects');
  process.env.PALIMPSEST_TEST_PROJECTS = '1';
  mkdirSync(join(tempDir, 'projects'));
  delete process.env.PALIMPSEST_UNDERSTUDY_DB;
});

afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  // A fixture folder made read only is made writable again so it can be removed.
  for (const d of readdirSync(tempDir)) chmodSync(join(tempDir, d), 0o755);
  rmSync(tempDir, { recursive: true, force: true });
});

function switchOn(on = true): void {
  patchSettings({ school: { ...getSettings().school, understudy: on } });
}

const STATEMENTS = [
  { id: 's1', text: 'Quiet surfaces, one accent.', weight: 3 },
  { id: 's2', text: 'Type sets the hierarchy, not boxes.', weight: 2 },
  { id: 's3', text: 'Rounded pills everywhere.', weight: 5, removed: true },
];
const PAIRS = [
  { id: 'p-a', at: '2026-11-10T10:00:00.000Z', pick: 'a' },
  { id: 'p-b', at: '2026-11-10T11:00:00.000Z', pick: 'b' },
  { id: 'p-none', at: '2026-11-10T12:00:00.000Z', pick: null },
  { id: 'p-neither', at: '2026-11-10T13:00:00.000Z', pick: 'neither' },
];

function fixture(o: { wal?: boolean; name?: string } = {}): string {
  const dir = join(tempDir, o.name ?? 'understudy');
  const path = makeUnderstudy(dir, { statements: STATEMENTS, pairs: PAIRS, wal: o.wal });
  process.env.PALIMPSEST_UNDERSTUDY_DB = path;
  return path;
}

test('statements come back without removed ones', () => {
  fixture();
  switchOn();
  assert.deepEqual(understudyStatements(), ['Quiet surfaces, one accent.', 'Type sets the hierarchy, not boxes.']);
});

test('pairs without a pick or with neither are skipped', () => {
  fixture();
  switchOn();
  const pairs = understudyPairs();
  assert.deepEqual(
    pairs.map((p) => [p.id, p.pick, p.scores]),
    [
      ['p-a', 'a', null],
      ['p-b', 'b', null],
    ],
  );
  assert.equal(pairs[0].at, '2026-11-10T10:00:00.000Z');
  assert.deepEqual(understudyCounts(), { statements: 2, pairs: 4, answered: 2, unreadable: null });
});

test('a WAL database opens through immutable when readOnly fails', () => {
  const path = fixture({ wal: true });
  const dir = join(tempDir, 'understudy');
  assert.deepEqual(readdirSync(dir), ['understudy.db'], 'closed cleanly: no -wal or -shm left');
  const header = readFileSync(path).subarray(18, 20);
  assert.deepEqual([...header], [2, 2], 'the file is in WAL mode');
  chmodSync(dir, 0o555);
  // A plain read-only open cannot create the -shm here, so its first read fails.
  const plain = new DatabaseSync(path, { readOnly: true });
  assert.throws(() => plain.prepare('select count(*) from statements').get());
  plain.close();

  switchOn();
  assert.deepEqual(understudyStatements(), ['Quiet surfaces, one accent.', 'Type sets the hierarchy, not boxes.']);
  assert.deepEqual(understudyCounts(), { statements: 2, pairs: 4, answered: 2, unreadable: null });
  assert.deepEqual(readdirSync(dir), ['understudy.db'], 'nothing was created beside it');
});

test('a write through the reader throws', () => {
  const path = fixture();
  const walPath = fixture({ wal: true, name: 'wal' });
  chmodSync(join(tempDir, 'wal'), 0o555);
  switchOn();
  for (const p of [path, walPath]) {
    process.env.PALIMPSEST_UNDERSTUDY_DB = p;
    const before = readFileSync(p);
    const db = understudyDb();
    assert.ok(db, 'opened');
    try {
      assert.throws(() => db.exec("update statements set removed = 1 where id = 's1'"), /readonly|read-only|read only/i);
      assert.throws(() => db.exec("insert into pairs (id, at, url, dimension, question, a_label, a_css, a_shot, b_label, b_css, b_shot) values ('x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x', 'x')"));
      assert.throws(() => db.exec('create table t (x)'));
    } finally {
      db.close();
    }
    assert.deepEqual(readFileSync(p), before, 'the file is byte for byte as it was');
  }
});

test('with the switch off nothing is read', () => {
  // No path at all: the switch is checked before the path is ever resolved.
  assert.deepEqual(understudyStatements(), []);
  assert.deepEqual(understudyPairs(), []);
  assert.equal(understudyCounts(), null);
  assert.equal(understudyDb(), null);

  // A path that would throw on any read is never touched.
  const unreadable = join(tempDir, 'unreadable.db');
  writeFileSync(unreadable, 'not a database');
  chmodSync(unreadable, 0o000);
  process.env.PALIMPSEST_UNDERSTUDY_DB = unreadable;
  assert.deepEqual(understudyStatements(), []);
  assert.deepEqual(understudyPairs(), []);
  assert.equal(understudyCounts(), null);
  assert.equal(understudyDb(), null);
  chmodSync(unreadable, 0o644);

  // The datasets read the real reader by default, and see nothing while it is off.
  fixture();
  assert.equal(rowsFor('taste', Date.parse('2026-11-12T00:00:00.000Z')).length, 0);
  assert.equal(thinCause('taste', Date.parse('2026-11-12T00:00:00.000Z')), 'No UI change has been inspected yet');
});

test('under a test the default path throws', () => {
  const real = join(homedir(), 'Library', 'Application Support', 'Understudy', 'understudy.db');
  delete process.env.PALIMPSEST_UNDERSTUDY_DB;
  assert.throws(() => understudyPath(), /refused/);
  switchOn();
  assert.throws(() => understudyStatements(), /refused/);
  assert.throws(() => understudyPairs(), /refused/);
  assert.throws(() => understudyCounts(), /refused/);
  assert.throws(() => understudyDb(), /refused/);
  for (const spelled of [real, real.toLowerCase(), join(real, '..', 'understudy.db'), join(real, '..', 'other.db')]) {
    process.env.PALIMPSEST_UNDERSTUDY_DB = spelled;
    assert.throws(() => understudyPath(), /refused/, spelled);
    assert.throws(() => understudyStatements(), /refused/, spelled);
  }
  process.env.PALIMPSEST_UNDERSTUDY_DB = '';
  assert.throws(() => understudyPath(), /refused/);
});

test('a missing database reads as empty and says it could not be read', () => {
  process.env.PALIMPSEST_UNDERSTUDY_DB = join(tempDir, 'absent', 'understudy.db');
  switchOn();
  assert.deepEqual(understudyStatements(), []);
  assert.deepEqual(understudyPairs(), []);
  assert.deepEqual(understudyCounts(), { statements: 0, pairs: 0, answered: 0, unreadable: 'no Understudy database was found' });
  assert.equal(existsSync(join(tempDir, 'absent')), false, 'nothing was created');
  assert.equal(thinCause('taste', Date.parse('2026-11-12T00:00:00.000Z')), 'No UI change has been inspected yet; Understudy could not be read: no Understudy database was found');
});

test('a database without the tables, or one that is not a database, is unreadable with the reason, not empty', () => {
  const dir = join(tempDir, 'odd');
  mkdirSync(dir);
  const path = join(dir, 'understudy.db');
  const db = new DatabaseSync(path);
  db.exec('create table other (x)');
  db.close();
  process.env.PALIMPSEST_UNDERSTUDY_DB = path;
  switchOn();
  const c = understudyCounts();
  assert.ok(c);
  assert.match(c.unreadable ?? '', /no such table/);
  assert.deepEqual([c.statements, c.pairs, c.answered], [0, 0, 0]);
  assert.match(thinCause('taste', Date.parse('2026-11-12T00:00:00.000Z')), /^No UI change has been inspected yet; Understudy could not be read: .*no such table/);

  const junk = join(dir, 'junk.db');
  writeFileSync(junk, 'this is not a database, it is a sentence long enough to fill a header');
  process.env.PALIMPSEST_UNDERSTUDY_DB = junk;
  assert.match(understudyCounts()?.unreadable ?? '', /not a database|file is not a database/i);
  assert.deepEqual(understudyStatements(), []);
});

test('statements are capped at 40, highest weight first, 300 characters each', () => {
  const statements = Array.from({ length: 50 }, (_, i) => ({ id: `s${String(i).padStart(2, '0')}`, text: `${i} ${'x'.repeat(400)}`, weight: i }));
  process.env.PALIMPSEST_UNDERSTUDY_DB = makeUnderstudy(join(tempDir, 'many'), { statements });
  switchOn();
  const got = understudyStatements();
  assert.equal(got.length, 40);
  assert.ok(got[0].startsWith('49 '), 'the heaviest first');
  assert.ok(got[39].startsWith('10 '), 'the lightest ten are left out');
  assert.ok(got.every((t) => t.length <= 300));
});

/** Every file in `dir` with its bytes, for before and after comparisons. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir).sort()) out[f] = readFileSync(join(dir, f)).toString('base64');
  return out;
}

test('reading a WAL database in a writable folder with no -shm leaves no file behind', () => {
  const path = fixture({ wal: true });
  const dir = join(tempDir, 'understudy');
  const before = snapshot(dir);
  assert.deepEqual(Object.keys(before), ['understudy.db']);
  switchOn();
  assert.equal(understudyStatements().length, 2);
  assert.equal(understudyPairs().length, 2);
  assert.equal(understudyCounts()?.answered, 2);
  const db = understudyDb();
  assert.ok(db);
  assert.equal((db.prepare('select count(*) n from statements').get() as { n: number }).n, 3);
  assert.deepEqual(readdirSync(dir), ['understudy.db'], 'nothing beside it while open');
  db.close();
  assert.deepEqual(snapshot(dir), before, 'the folder is as it was, byte for byte');
  assert.ok(existsSync(path));
});

test('reading a WAL database while Understudy holds it open reads its live data and leaves its files as they were', () => {
  const path = fixture({ wal: true });
  const dir = join(tempDir, 'understudy');
  // Understudy running: its own connection holds the -wal and -shm, with a statement not yet checkpointed.
  const live = new DatabaseSync(path);
  live.exec("pragma wal_autocheckpoint = 0; insert into statements (id, text, aspect, evidence) values ('s9', 'Fresh from the live app.', 'look', '[]')");
  try {
    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ['understudy.db', 'understudy.db-shm', 'understudy.db-wal']);
    const dbBytes = readFileSync(path);
    const walBytes = readFileSync(`${path}-wal`);
    switchOn();
    assert.ok(understudyStatements().includes('Fresh from the live app.'), 'the frames still in the WAL are read');
    assert.equal(understudyCounts()?.statements, 3);
    assert.deepEqual(readdirSync(dir).sort(), files, 'no file added or removed');
    assert.deepEqual(readFileSync(path), dbBytes, 'the database file is byte for byte as it was');
    assert.deepEqual(readFileSync(`${path}-wal`), walBytes, 'the WAL is byte for byte as it was');
  } finally {
    live.close();
  }
});

test('reading a rollback-journal database leaves no file behind', () => {
  fixture();
  const dir = join(tempDir, 'understudy');
  const before = snapshot(dir);
  switchOn();
  assert.equal(understudyStatements().length, 2);
  assert.equal(understudyCounts()?.pairs, 4);
  assert.deepEqual(snapshot(dir), before);
});

test('a pair is scored once by the local vision judge under a school lease, cached and fed to the taste net', async () => {
  fixture();
  writeShots(join(tempDir, 'understudy'), 'p-a', PNG);
  switchOn();
  const judged: JudgeInput[] = [];
  setProvider(
    'ollama',
    fakeProvider({
      judge: (i) => {
        judged.push(i);
        return { before: 4, after: 7, notes: 'B is calmer.', usage: { weightedTokens: 0, seconds: 2, usd: 0, credits: 0.2 } };
      },
    }),
  );
  const pair = understudyPairs()[0];
  assert.deepEqual(await scorePair(pair), { a: 4, b: 7 });
  assert.equal(judged.length, 1);
  assert.equal(judged[0].before.length, 1);
  assert.equal(judged[0].after.length, 1);
  assert.deepEqual(judged[0].bible, ['Quiet surfaces, one accent.', 'Type sets the hierarchy, not boxes.']);
  assert.equal(liveLeaseCount(), 0, 'the lease was released');
  const rows = openDb().prepare("SELECT firm_id, kind FROM credits WHERE kind = 'school'").all() as Array<{ firm_id: string | null }>;
  assert.equal(rows.length, 1, 'charged once to the city as school');
  assert.equal(rows[0].firm_id, null);

  // Cached: a second call does not judge again, and the pairs carry the scores.
  assert.deepEqual(await scorePair(pair), { a: 4, b: 7 });
  assert.equal(judged.length, 1);
  assert.deepEqual(understudyPairs()[0].scores, { a: 4, b: 7 });

  // A pair whose shots are missing is not scored.
  assert.equal(await scorePair(understudyPairs()[1]), null);
  assert.equal(judged.length, 1);

  // The taste net reads the scored pair by default, and thinCause reads the live counts.
  const now = Date.parse('2026-11-12T00:00:00.000Z');
  const taste = rowsFor('taste', now);
  assert.deepEqual(taste.map((r) => [r.id, r.y]), [['pair:p-a', 1]]);
  assert.equal(thinCause('taste', now), 'No UI change has been inspected yet; Understudy has 2 statements and 2 answered pairs');
});

test('a shot outside Understudy\'s folder is never read', async () => {
  const outside = join(tempDir, 'elsewhere.png');
  writeFileSync(outside, PNG);
  const dir = join(tempDir, 'understudy');
  process.env.PALIMPSEST_UNDERSTUDY_DB = makeUnderstudy(dir, { pairs: [{ id: 'p-x', at: '2026-11-10T10:00:00.000Z', pick: 'a', aShot: outside, bShot: outside }] });
  switchOn();
  let calls = 0;
  setProvider('ollama', fakeProvider({ judge: () => (calls++, { before: 1, after: 2, notes: '', usage: { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 } }) }));
  assert.equal(await scorePair(understudyPairs()[0]), null);
  assert.equal(calls, 0);
});
