/**
 * Arenas from planted bugs (Phase 4 Task 19, ruling 20). A tiny JS repo
 * with a real `node --test` suite in a temp bare mirror, the sandbox off
 * (test safety rule 7), a temp data home and Beagle's store under its temp
 * school (rule 13). The gate is a fake; the spawner is the real one, wrapped
 * to note what each command ran with. Nothing reaches a real repo, GitHub,
 * the network or Beagle's real home.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { realSpawner, setSpawner, type Spawner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { query } from '../engine/ledger.js';
import { unattended } from '../engine/market/budget.js';
import { getRepo } from '../engine/repos.js';
import { arenaInfo as arenaInfoOf, arenaTasks, buildPlanted, candidatesOf, mutantCapMs, resumeArenas, setMutantCap, type Candidate } from '../engine/school/arenas.js';
import type { BeagleArena } from '../engine/school/beagle-api.js';
import { closeBeagle, loadBeagle } from '../engine/school/beagle.js';
import { schoolOff, TURNED_OFF_REASON } from '../engine/school/tick.js';
import { setGate } from '../engine/school/trainer.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { localCredits } from '../shared/credits.js';
import type { ArenaInfo, GateState, Repo } from '../shared/types.js';
import { CHECK_MS } from '../engine/guild/checks.js';
import { checks, FULL, git, makeRepo, setUp, tearDown, tempDir } from './guild-fixtures.js';

/** 03:00 local on 12 November 2026: inside the default window, unattended. */
const NOW = new Date(2026, 10, 12, 3, 0).getTime();

const MATH = [
  'export function max(a, b) {',
  '  if (a > b) return a;',
  '  return b;',
  '}',
  '',
  'export function isEven(n) {',
  '  return n % 2 === 0;',
  '}',
  '',
  '// nothing tests this one, so no bug planted in it is ever caught',
  'export function untested(n) {',
  '  return n > 10;',
  '}',
  '',
].join('\n');

const SUITE = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { max, isEven } from '../src/math.js';",
  "test('max', () => { assert.equal(max(3, 1), 3); assert.equal(max(1, 3), 3); });",
  "test('isEven', () => { assert.equal(isEven(4), true); assert.equal(isEven(3), false); });",
  '',
].join('\n');

const UNTESTED_LINE = 12;

interface Spawn {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** Whether the clone it ran in carried the base's install at that moment. */
  installed: boolean;
  maxMs: number | undefined;
}
let spawns: Spawn[] = [];
let onSpawn: ((s: Spawn) => void) | null = null;

const recording: Spawner = (cmd, args, opts) => {
  const s = { cmd, args, cwd: opts.cwd ?? '', env: { ...(opts.env ?? {}) }, installed: existsSync(join(opts.cwd ?? '', 'installed.txt')), maxMs: opts.maxMs };
  spawns.push(s);
  onSpawn?.(s);
  return realSpawner(cmd, args, opts);
};

function gateState(ok: boolean, reason: string | null = null): GateState {
  return { kind: 'heavy', ok, reason, power: ok ? 'ac' : 'battery', powerMode: 0, idleMin: 60, inWindow: true, trainNowUntil: null, freeGB: 300, thermal: 'nominal' };
}

function tinyRepo(over: Partial<Repo> = {}): Repo {
  makeRepo(checks({ test: 'node --test test/math.test.js', install: 'touch installed.txt' }), {
    'package.json': JSON.stringify({ name: 'widgets', type: 'module', scripts: { test: 'node --test test/math.test.js' } }, null, 2),
    'src/math.js': MATH,
    'test/math.test.js': SUITE,
  });
  const repo = { ...getRepo(FULL)!, ...over };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
  return repo;
}

const gradingSpawns = (id: string) => spawns.filter((s) => s.cwd.includes(`arena-${id}-grade`));
const installSpawns = () => spawns.filter((s) => s.args.join(' ').includes('touch installed.txt'));

beforeEach(() => {
  setUp('school-arenas');
  process.env.BEAGLE_BACKOFF_MS = '0';
  spawns = [];
  onSpawn = null;
  setSpawner(recording);
  setGate(async () => gateState(true));
  patchSettings({ school: { ...getSettings().school, enabled: true } });
});

afterEach(async () => {
  setMutantCap(null);
  setGate(null);
  closeBeagle();
  delete process.env.BEAGLE_HOME;
  delete process.env.BEAGLE_BACKOFF_MS;
  await tearDown();
});

test('a mutant the suite passes is dropped, one it fails is kept', async () => {
  const repo = tinyRepo();
  const info = await buildPlanted(repo, NOW);
  assert.equal(info.status, 'ready', info.reason ?? '');
  assert.equal(info.kind, 'planted');
  assert.equal(info.repo, FULL);
  assert.ok(info.candidates > info.kept && info.kept > 0, `${info.kept} of ${info.candidates} kept`);

  const tasks = arenaTasks(info.id);
  assert.equal(tasks.length, info.kept);
  assert.equal(info.tasks.breeding + info.tasks.race + info.tasks.sealed, info.kept);
  const kept = tasks.map((t) => t.truth);
  assert.ok(kept.some((m) => m.file === 'src/math.js' && m.line === 2 && m.mutated === '  if (a <= b) return a;'), 'the flipped comparison in max is kept');
  assert.ok(!kept.some((m) => m.line === UNTESTED_LINE), 'no bug in the untested function is kept');
  for (const t of tasks) {
    assert.ok(t.id.startsWith(`${info.id}:`));
    assert.ok(t.truth.failing.length > 0, 'a kept task names the tests it breaks');
    assert.equal(JSON.stringify(t.input).includes(t.truth.mutated), false, 'the task never shows the planted line');
    assert.equal(JSON.stringify(t.input).includes(tempDir), false, 'the task never shows a path of this Mac');
  }
  const states = candidatesOf(info.id);
  assert.equal(states.length, info.candidates);
  assert.ok(states.some((c) => c.mutant.line === UNTESTED_LINE && c.state === 'dropped'), 'a bug the suite passes is dropped');
  assert.ok(states.every((c) => c.state !== 'untried'));
  assert.ok(states.every((c) => c.mutant.file === 'src/math.js'), 'nothing is planted in a test file or the manifest');
});

test("kept tasks are in Beagle's store under the arena id with their splits, and the recorded sealedHash is Beagle's sealedHash of that arena", async () => {
  const repo = tinyRepo();
  const info = await buildPlanted(repo, NOW);
  assert.equal(info.status, 'ready', info.reason ?? '');

  const b = await loadBeagle();
  const rows = b.store.open().prepare('SELECT id, split FROM tasks WHERE arena = ? ORDER BY id').all(info.id) as Array<{ id: string; split: string }>;
  const ours = arenaTasks(info.id).map((t) => ({ id: t.id, split: t.split })).sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(rows.map((r) => ({ ...r })), ours);
  for (const r of rows) assert.equal(r.split, b.arenas.splitOf(r.id));
  for (const split of ['breeding', 'race', 'sealed'] as const) assert.equal(arenaTasks(info.id, split).length, info.tasks[split]);
  const arenaRow = b.store.open().prepare('SELECT id FROM arenas WHERE id = ?').get(info.id);
  assert.ok(arenaRow, "the arena is in Beagle's arenas table");

  // Beagle reads an arena's tasks through its registered data; Arena.data is the arena id.
  const stub = { id: info.id, data: info.id, name: 'stub', describe: '', answer: {}, grade: () => 0, tools: [], show: () => '' } as BeagleArena;
  b.arenas.registerArena(stub);
  try {
    assert.equal(info.sealedHash, b.race.sealedHash(info.id));
  } finally {
    b.arenas.unregisterArena(info.id);
  }
  const built = query({ kind: 'arena.built' }).map((e) => (e.data as { arena: ArenaInfo }).arena);
  assert.equal(built.at(-1)?.id, info.id);
  assert.equal(built.at(-1)?.sealedHash, info.sealedHash);
  const row = openDb().prepare('SELECT json FROM arenas WHERE id = ?').get(info.id) as { json: string };
  assert.deepEqual(JSON.parse(row.json), info);
});

test('grading runs carry no proxy', async () => {
  const repo = tinyRepo();
  const info = await buildPlanted(repo, NOW);
  assert.equal(info.status, 'ready', info.reason ?? '');

  // The install ran once, in the arena base, through the install egress.
  const install = installSpawns();
  assert.equal(install.length, 1, 'the dependencies are installed once');
  const installProxy = install[0].env.HTTPS_PROXY ?? '';
  assert.doesNotMatch(installProxy, /@127\.0\.0\.1:9$/, 'the install had its egress proxy');

  // Every grading run (the head's suite, then each mutant's) points at a closed port, with no proxy live.
  const grading = gradingSpawns(info.id);
  assert.equal(grading.length, info.candidates + 1, 'the head once, then each candidate once');
  for (const s of grading) {
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      assert.match(s.env[k] ?? '', /@127\.0\.0\.1:9$/, `${k} of a grading run is the closed port`);
    }
    assert.ok(s.installed, 'each grading clone carries the base install');
  }
  assert.equal(existsSync(join(paths().runs, `arena-${info.id}`, 'ctl', 'egress.json')), false, 'the install egress is closed and forgotten');
  assert.equal(existsSync(join(paths().runs, `arena-${info.id}-grade`)), false, 'the grading root is cleared');
});

test('a gate loss pauses and resumes the rest', async () => {
  const repo = tinyRepo();
  let calls = 0;
  setGate(async () => (++calls <= 3 ? gateState(true) : gateState(false, 'on battery')));
  const paused = await buildPlanted(repo, NOW);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.reason, 'on battery');
  const first = candidatesOf(paused.id);
  const triedFirst = first.filter((c) => c.state !== 'untried').length;
  assert.equal(triedFirst, 2, 'the gate held for the start and two candidates');
  assert.equal(arenaTasks(paused.id).length, 0, 'a paused arena has no tasks yet');
  assert.equal(query({ kind: 'arena.built' }).length, 1, 'the pause is recorded with the arena');

  const before = spawns.length;
  setGate(async () => gateState(true));
  // The next night's tick resumes it (never starting a new one).
  const resumed = await resumeArenas(NOW + 24 * 60 * 60 * 1000);
  assert.equal(resumed.length, 1);
  const done = resumed[0];
  assert.equal(done.id, paused.id, 'the next night resumes the paused arena');
  assert.equal(done.status, 'ready', done.reason ?? '');
  const second = spawns.slice(before);
  assert.equal(second.filter((s) => s.cwd.includes(`arena-${done.id}-grade`)).length, paused.candidates - triedFirst, 'only the untried candidates run');
  assert.equal(installSpawns().length, 1, 'the install is not run again');
  const states = candidatesOf(done.id);
  for (const c of first.filter((x) => x.state !== 'untried')) {
    assert.equal(states.find((s) => s.key === c.key)?.state, c.state, 'a tried candidate keeps its result');
  }
});

test('turning the school off stops a build, which pauses', async () => {
  const repo = tinyRepo();
  let graded = 0;
  onSpawn = (s) => {
    if (s.cwd.includes('-grade') && ++graded === 2) schoolOff(NOW);
  };
  const info = await buildPlanted(repo, NOW);
  assert.equal(info.status, 'paused');
  assert.equal(info.reason, TURNED_OFF_REASON);
  assert.ok(candidatesOf(info.id).some((c) => c.state === 'untried'));
  patchSettings({ school: { ...getSettings().school, enabled: false } });
  assert.deepEqual(await resumeArenas(NOW), [], 'nothing resumes while the school is off');
  const off = await buildPlanted(repo, NOW);
  assert.equal(off.status, 'failed');
  assert.match(off.reason ?? '', /school is off/);
  assert.equal(arenaInfoOf(info.id)?.status, 'paused', 'a refusal leaves the paused arena as it was');
});

test('a market-off repo is refused', async () => {
  const off = tinyRepo({ market: false });
  const r = await buildPlanted(off, NOW);
  assert.equal(r.status, 'failed');
  assert.match(r.reason ?? '', /market is off/);

  const noTest = { ...off, market: true, checks: checks({ test: null }) };
  const r2 = await buildPlanted(noTest, NOW);
  assert.equal(r2.status, 'failed');
  assert.match(r2.reason ?? '', /no test command/);

  assert.equal(spawns.length, 0, 'nothing ran');
  assert.equal(query({ kind: 'arena.built' }).length, 0);
  assert.equal((openDb().prepare('SELECT COUNT(*) AS n FROM arenas').get() as { n: number }).n, 0);
});

test('charged as local school credits', async () => {
  const repo = tinyRepo();
  const info = await buildPlanted(repo, NOW);
  assert.equal(info.status, 'ready', info.reason ?? '');
  const rows = openDb().prepare('SELECT firm_id, run_id, kind, amount, json FROM credits WHERE run_id = ?').all(info.id) as Array<{ firm_id: string | null; run_id: string; kind: string; amount: number; json: string }>;
  assert.equal(rows.length, 1);
  const row = rows[0];
  const json = JSON.parse(row.json) as { pool: string; usage: { seconds: number }; unattended: boolean };
  assert.equal(row.kind, 'school');
  assert.equal(row.firm_id, null);
  assert.equal(json.pool, 'local');
  assert.ok(json.usage.seconds > 0);
  assert.equal(row.amount, localCredits(json.usage.seconds, 0));
  assert.ok(row.amount > 0);
  assert.equal(json.unattended, unattended(NOW));
});

test('the arena base keeps its planted bugs out of it', async () => {
  const repo = tinyRepo();
  const info = await buildPlanted(repo, NOW);
  const base = join(paths().runs, `arena-${info.id}`, 'base');
  assert.equal(readFileSync(join(base, 'src', 'math.js'), 'utf8'), MATH, 'the base stays at the head');
  assert.ok(existsSync(join(base, 'installed.txt')), 'the base keeps its install for grading');
});

// ---------------------------------------------------------------- fix round 1

/** The tiny repo with two tracked links in src: one to an absolute path, one up and out by ../. */
function linkedRepo(): { repo: Repo; abs: string; up: string } {
  const repo = tinyRepo();
  const abs = join(tempDir, 'victim-abs.js');
  const up = join(tempDir, 'home', 'victim-up.js');
  writeFileSync(abs, MATH);
  writeFileSync(up, MATH);
  const work = join(tempDir, 'work', FULL.replace('/', '__'));
  symlinkSync(abs, join(work, 'src', 'abs.js'));
  // From src/ in any clone under <home>/runs/<root>/<clone>, four levels up is the temp home.
  symlinkSync('../../../../victim-up.js', join(work, 'src', 'up.js'));
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'links');
  return { repo, abs, up };
}

const linkBug = (file: string): Candidate => ({
  key: `link-${file.replace(/\W/g, '')}`,
  mutant: { file, line: 2, original: '  if (a > b) return a;', mutated: '  if (a <= b) return a;', op: 'comparison' },
  state: 'untried',
  failing: [],
  output: '',
});

test('a tracked link is never planted in, and nothing outside the clone changes', async () => {
  const { repo, abs, up } = linkedRepo();
  const info = await buildPlanted(repo, NOW);
  assert.equal(info.status, 'ready', info.reason ?? '');
  const files = new Set(candidatesOf(info.id).map((c) => c.mutant.file));
  assert.ok(!files.has('src/abs.js') && !files.has('src/up.js'), `a link was a candidate: ${[...files]}`);
  assert.equal(readFileSync(abs, 'utf8'), MATH);
  assert.equal(readFileSync(up, 'utf8'), MATH);
});

test('a planted bug whose file is a link is skipped, and nothing is written through it', async () => {
  const { repo, abs, up } = linkedRepo();
  let calls = 0;
  setGate(async () => (++calls <= 1 ? gateState(true) : gateState(false, 'on battery')));
  const paused = await buildPlanted(repo, NOW);
  assert.equal(paused.status, 'paused');
  // Bugs aimed at the links, as a candidate list from before the links were refused would hold them.
  const file = join(paths().school, 'arenas', paused.id, 'state.json');
  const state = JSON.parse(readFileSync(file, 'utf8')) as { candidates: Candidate[] };
  state.candidates = [linkBug('src/abs.js'), linkBug('src/up.js'), ...state.candidates];
  writeFileSync(file, JSON.stringify(state));

  setGate(async () => gateState(true));
  const [done] = await resumeArenas(NOW);
  assert.equal(done.status, 'ready', done.reason ?? '');
  const states = candidatesOf(done.id);
  for (const key of ['link-srcabsjs', 'link-srcupjs']) assert.equal(states.find((c) => c.key === key)?.state, 'skipped', key);
  assert.equal(readFileSync(abs, 'utf8'), MATH, 'the absolute link target is untouched');
  assert.equal(readFileSync(up, 'utf8'), MATH, 'the ../ link target is untouched');
});

test('a mutant whose suite hangs is dropped at the mutant cap, not after 15 minutes', async () => {
  makeRepo(checks({ test: 'node --test test/count.test.js' }), {
    'package.json': JSON.stringify({ name: 'widgets', type: 'module' }),
    'src/count.js': ['export function countdown(n) {', '  let k = 0;', '  while (n !== 0) {', '    n -= 1;', '    k += 1;', '  }', '  return k;', '}', ''].join('\n'),
    'test/count.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { countdown } from '../src/count.js';\ntest('countdown', () => { assert.equal(countdown(3), 3); });\n",
  });
  setMutantCap({ floorMs: 2_000, slackMs: 1_000 });
  const t0 = Date.now();
  const info = await buildPlanted(getRepo(FULL)!, NOW);
  assert.equal(info.status, 'ready', info.reason ?? '');
  assert.ok(Date.now() - t0 < 120_000, 'the build did not wait out a hang');

  const hang = candidatesOf(info.id).find((c) => c.mutant.mutated === '    n -= 2;');
  assert.ok(hang, 'the hanging bug was a candidate');
  assert.equal(hang.state, 'dropped', 'a suite that never ends does not keep its bug');

  const grading = gradingSpawns(info.id);
  assert.equal(grading[0].maxMs, CHECK_MS, 'the head suite has the full check time');
  const caps = new Set(grading.slice(1).map((g) => g.maxMs));
  assert.equal(caps.size, 1);
  const cap = [...caps][0] ?? 0;
  assert.ok(cap >= 3_000 && cap < 60_000, `cap ${cap}`);
  assert.equal(mutantCapMs(null), 3_000);
  setMutantCap(null);
  assert.equal(mutantCapMs(1_000), 70_000, 'the real floor is 60 s, plus 10 s of slack');
  assert.equal(mutantCapMs(20_000), 110_000, 'five times a slower head suite, plus slack');
  assert.equal(mutantCapMs(10 * 60_000), CHECK_MS, 'never past the full check time');
});
