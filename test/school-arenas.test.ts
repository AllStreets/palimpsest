/**
 * Arenas from planted bugs and from past changes (Phase 4 Tasks 19 and 20,
 * ruling 20). A tiny JS repo
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
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { realRunner, realSpawner, setRunner, setSpawner, type Runner, type Spawner } from '../engine/exec.js';
import { mirrorDir } from '../engine/mirror.js';
import { setTestCheck } from '../engine/school/history.js';
import { resetGateCache } from '../engine/school/gate.js';
import { paths } from '../engine/home.js';
import { query } from '../engine/ledger.js';
import { unattended } from '../engine/market/budget.js';
import { getRepo } from '../engine/repos.js';
import { arenaInfo as arenaInfoOf, arenaTasks, buildPast, buildPlanted, candidatesOf, mutantCapMs, pastCandidatesOf, resumeArenas, sealedRefs, setMutantCap, type Candidate, type PastInput, type PastTruth, type PlantedTruth } from '../engine/school/arenas.js';
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
  setRunner(realRunner);
  setTestCheck(null);
  resetGateCache();
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
  const kept = tasks.map((t) => t.truth as PlantedTruth);
  assert.ok(kept.some((m) => m.file === 'src/math.js' && m.line === 2 && m.mutated === '  if (a <= b) return a;'), 'the flipped comparison in max is kept');
  assert.ok(!kept.some((m) => m.line === UNTESTED_LINE), 'no bug in the untested function is kept');
  for (const t of tasks) {
    assert.ok(t.id.startsWith(`${info.id}:`));
    assert.ok(t.truth.failing.length > 0, 'a kept task names the tests it breaks');
    assert.equal(JSON.stringify(t.input).includes((t.truth as PlantedTruth).mutated), false, 'the task never shows the planted line');
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

// ---------------------------------------------------------------- Task 20: past changes

const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const FIX = join(import.meta.dirname, 'fixtures', 'pmset');
const fx = (name: string): string => readFileSync(join(FIX, `${name}.txt`), 'utf8');

/** His fix: before it, max returned the smaller; the fix and its new test come in one commit. */
const BUGGY = 'export function max(a, b) {\n  return a < b ? a : b;\n}\n';
const FIXED = 'export function max(a, b) {\n  return a > b ? a : b;\n}\n';
const FIXED_LINE = 'return a > b ? a : b;';
const OLD_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { max } from '../src/math.js';\ntest('max of equals', () => { assert.equal(max(2, 2), 2); });\n";
const NEW_TEST = OLD_TEST + "test('max of unequals', () => { assert.equal(max(3, 1), 3); });\n";

let prs: object[] = [];
let calls: Array<{ cmd: string; args: string[] }> = [];

/** git and the gate's probes, noted; gh answers only `pr list`. Nothing else is expected. */
const pastRunner: Runner = async (cmd, args, opts) => {
  const base = cmd.split('/').pop() ?? cmd;
  calls.push({ cmd: base, args: [...args] });
  const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
  if (base === 'gh') return args[0] === 'pr' && args[1] === 'list' ? ok(JSON.stringify(prs)) : { stdout: '', stderr: 'unexpected gh', code: 1 };
  if (base === 'pmset' && args.join(' ') === '-g batt') return ok(fx('batt-ac'));
  if (base === 'pmset' && args.join(' ') === '-g therm') return ok(fx('therm-none'));
  if (base === 'pmset' && args.join(' ') === '-g') return ok(fx('g-automatic'));
  if (base === 'ioreg') return ok(`+-o IOHIDSystem\n    | {\n    |   "HIDIdleTime" = ${3600n * 1_000_000_000n}\n    | }\n`);
  if (base === 'df') return ok(`Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s5 971298980 636638860 ${Math.round(300e9 / 1024)} 68% 1 1 0% /System/Volumes/Data\n`);
  if (base === 'git') return realRunner(cmd, args, opts);
  return { stdout: '', stderr: `unexpected ${base}`, code: 1 };
};

/** git in `cwd` with the author and committer dates given. */
function gitDated(cwd: string, author: string, committer: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: author, GIT_COMMITTER_DATE: committer },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commitAt(work: string, author: string, committer: string, files: Record<string, string>, message: string): string {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, name)), { recursive: true });
    writeFileSync(join(work, name), text);
  }
  gitDated(work, author, committer, 'add', '.');
  gitDated(work, author, committer, 'commit', '-q', '-m', message);
  return gitDated(work, author, committer, 'rev-parse', 'HEAD');
}

interface PastWorld {
  repo: Repo;
  fix: string;
  fixParent: string;
  tidy: string;
  r1: string;
  r2: string;
  /** PR 11, merged with a merge commit, and the one commit on its branch. */
  merge: string;
  side: string;
}

/**
 * His history: a buggy max with a test that misses it (100 days ago); his
 * fix with the test that catches it (60); a tidy-up whose new test already
 * passed before it (50); and PR 9, rebase-merged as two commits written in
 * the same second (40), whose last commit's parent is the PR's own first
 * commit, not the branch before the PR.
 */
function pastWorld(o: { redHead?: boolean; movedDeps?: boolean } = {}): PastWorld {
  const repo = tinyRepo();
  const fresh = { ...repo, checks: checks({ test: 'node --test' }) };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(fresh.fullName, JSON.stringify(fresh));
  const work = join(tempDir, 'past-work');
  mkdirSync(work, { recursive: true });
  gitDated(work, ago(100), ago(100), 'init', '-q', '-b', 'main');
  const first = commitAt(work, ago(100), ago(100), { 'package.json': JSON.stringify({ name: 'widgets', type: 'module' }), 'src/math.js': BUGGY, 'test/math.test.js': OLD_TEST }, 'first');
  const fix = commitAt(work, ago(60), ago(60), { 'src/math.js': FIXED, 'test/math.test.js': NEW_TEST }, 'Fix max for unequal numbers');
  // Between the fix and the tidy-up, his manifest moved: the fix's parent no longer has the head's dependencies.
  if (o.movedDeps) commitAt(work, ago(55), ago(55), { 'package.json': JSON.stringify({ name: 'widgets', type: 'module', version: '1.1.0' }) }, 'Bump the version');
  const tidy = commitAt(work, ago(50), ago(50), { 'src/math.js': `// the larger of two\n${FIXED}`, 'test/same.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { max } from '../src/math.js';\ntest('max of fours', () => { assert.equal(max(4, 4), 4); });\n" }, 'Say what max does');
  const r1 = commitAt(work, ago(45), ago(40), { 'src/even.js': 'export const isEven = (n) => n % 2 === 0;\n', 'test/even.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isEven } from '../src/even.js';\ntest('even', () => { assert.equal(isEven(4), true); });\n" }, 'Add isEven');
  const r2 = commitAt(work, ago(44), ago(40), { 'src/even.js': 'export const isEven = (n) => n % 2 === 0;\nexport const isOdd = (n) => !isEven(n);\n', 'test/odd.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { isOdd } from '../src/even.js';\ntest('odd', () => { assert.equal(isOdd(3), true); });\n" }, 'Add isOdd');
  // PR 11: a branch with one commit adding half() and its test, merged with --no-ff.
  gitDated(work, ago(36), ago(36), 'checkout', '-q', '-b', 'feat');
  const side = commitAt(work, ago(36), ago(36), { 'src/half.js': 'export const half = (n) => n / 2;\n', 'test/half.test.js': "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { half } from '../src/half.js';\ntest('half', () => { assert.equal(half(8), 4); });\n" }, 'Add half');
  gitDated(work, ago(35), ago(35), 'checkout', '-q', 'main');
  gitDated(work, ago(35), ago(35), 'merge', '-q', '--no-ff', '-m', 'Merge pull request #11 from acme/feat', 'feat');
  const merge = gitDated(work, ago(35), ago(35), 'rev-parse', 'HEAD');
  // A test that fails at the head (too new to be verified, and no source touched).
  if (o.redHead) commitAt(work, ago(10), ago(10), { 'test/red.test.js': "import { test } from 'node:test';\ntest('red', () => { throw new Error('red'); });\n" }, 'A red test');
  // The mirror is his history alone (the planted fixture's mirror is replaced).
  spawnSync('rm', ['-rf', mirrorDir(FULL)]);
  const r = spawnSync('git', ['clone', '-q', '--bare', work, mirrorDir(FULL)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(r.status, 0, r.stderr);
  prs = [
    { number: 11, title: 'Add half', mergedAt: ago(35), mergeCommit: { oid: merge }, url: `https://github.com/${FULL}/pull/11`, headRefName: 'feat' },
    { number: 9, title: 'Even and odd', mergedAt: ago(40), mergeCommit: { oid: r2 }, url: `https://github.com/${FULL}/pull/9`, headRefName: 'even' },
  ];
  return { repo: getRepo(FULL)!, fix, fixParent: first, tidy, r1, r2, merge, side };
}

function pastSetUp(): void {
  calls = [];
  setRunner(pastRunner);
  resetGateCache();
  patchSettings({ school: { ...getSettings().school, enabled: true, commitsAsWork: true } });
  // His commits' own tests passed at each commit (the history's test check, faked).
  setTestCheck(async () => ({ passed: true, detail: 'passed' }));
}

test('a verified commit with a test that fails at its parent becomes a task', async () => {
  pastSetUp();
  const w = pastWorld();
  const info = await buildPast(w.repo, NOW);
  assert.equal(info.status, 'ready', info.reason ?? '');
  assert.equal(info.kind, 'past');
  const tasks = arenaTasks(info.id);
  const t = tasks.find((x) => x.ref === w.fix);
  assert.ok(t, `the fix is a task: ${tasks.map((x) => x.ref)}`);
  const truth = t.truth as PastTruth;
  assert.equal(truth.sha, w.fix);
  assert.equal(truth.parent, w.fixParent);
  assert.deepEqual(truth.testFiles, ['test/math.test.js']);
  assert.deepEqual(truth.sourceFiles, ['src/math.js']);
  assert.ok(truth.failing.some((n) => /max of unequals/.test(n)), `failing: ${truth.failing}`);
  assert.ok(info.kept <= 40);
});

test('one whose test already passed at its parent does not', async () => {
  pastSetUp();
  const w = pastWorld();
  const info = await buildPast(w.repo, NOW);
  assert.equal(info.status, 'ready', info.reason ?? '');
  assert.ok(!arenaTasks(info.id).some((x) => x.ref === w.tidy));
  assert.equal(pastCandidatesOf(info.id).find((c) => c.change.sha === w.tidy)?.state, 'dropped');
});

test('a rebase-merged PR whose first parent is not on the base is skipped', async () => {
  pastSetUp();
  const w = pastWorld();
  const info = await buildPast(w.repo, NOW);
  assert.equal(info.status, 'ready', info.reason ?? '');
  assert.ok(!arenaTasks(info.id).some((x) => x.ref === '9' || (x.truth as PastTruth).sha === w.r2), 'PR 9 is no task');
  assert.ok(!pastCandidatesOf(info.id).some((c) => c.change.sha === w.r2), 'PR 9 is not even a candidate');
  // Its first commit, his own on the branch, stands as a commit of his.
  assert.ok(arenaTasks(info.id).some((x) => x.ref === w.r1));
});

test('its task shows the failing test, not the fix', async () => {
  pastSetUp();
  const w = pastWorld();
  const info = await buildPast(w.repo, NOW);
  const t = arenaTasks(info.id).find((x) => x.ref === w.fix)!;
  const input = t.input as PastInput;
  const shown = JSON.stringify(input);
  assert.match(input.tests, /max of unequals/, 'the new test is shown');
  assert.ok(!shown.includes(FIXED_LINE), 'the fix is never shown');
  assert.ok(!shown.includes(w.fix), 'nor the sha of the fix');
  assert.ok(!shown.includes(tempDir), 'nor a path of this Mac');
  assert.ok((t.truth as PastTruth).fix.includes(FIXED_LINE), 'the truth keeps the fix');
  for (const x of arenaTasks(info.id)) assert.ok(x.input.output.length <= 4_000, 'the output kept is its tail, at most 4,000 characters');
});

test('sealedRefs names the sealed tasks', async () => {
  pastSetUp();
  const w = pastWorld();
  const info = await buildPast(w.repo, NOW);
  const sealed = arenaTasks(info.id, 'sealed');
  const open = arenaTasks(info.id).filter((x) => x.split !== 'sealed');
  // One more sealed task, of another arena, as a past build would write it.
  openDb()
    .prepare('INSERT INTO arena_tasks (id, arena, split, ref, json) VALUES (?, ?, ?, ?, ?)')
    .run('other:pr12', 'other', 'sealed', '12', JSON.stringify({ id: 'other:pr12', arena: 'other', split: 'sealed', ref: '12', input: {}, truth: { kind: 'past', sha: 'a'.repeat(40) } }));
  const refs = sealedRefs();
  assert.ok(refs.has('12') && refs.has('a'.repeat(40)));
  const want = new Set<string>(['12', 'a'.repeat(40)]);
  for (const t of sealed) {
    const truth = t.truth as PastTruth;
    for (const v of [t.ref!, truth.ref, truth.sha, ...truth.commits]) {
      assert.ok(refs.has(v), `${v} of a sealed task is named`);
      want.add(v);
    }
  }
  for (const t of open) assert.ok(!refs.has((t.truth as PastTruth).sha), `${t.ref} is not sealed`);
  assert.deepEqual([...refs].sort(), [...want].sort(), 'nothing else is named');
});

test("a sealed merge-commit PR seals its inner commits and history's ref", async () => {
  pastSetUp();
  const w = pastWorld();
  const info = await buildPast(w.repo, NOW);
  assert.equal(info.status, 'ready', info.reason ?? '');
  const t = arenaTasks(info.id).find((x) => x.ref === '11');
  assert.ok(t, 'PR 11 is a task');
  const truth = t.truth as PastTruth;
  assert.equal(truth.ref, 'pr:11');
  assert.deepEqual([...truth.commits].sort(), [w.merge, w.side].sort(), 'the merge and the commit on its branch');
  // Sealed (whatever split it drew), it seals every commit it brought in.
  openDb().prepare("UPDATE arena_tasks SET split = 'sealed' WHERE id = ?").run(t.id);
  const refs = sealedRefs();
  for (const v of ['11', 'pr:11', w.merge, w.side]) assert.ok(refs.has(v), `${v} is sealed`);
});

test('a past task directory holds no object of the fix', async () => {
  pastSetUp();
  const w = pastWorld();
  const seen: Array<{ git: boolean; commits: string; fixObject: boolean }> = [];
  onSpawn = (sp) => {
    if (!sp.cwd.includes('-grade')) return;
    let math = '';
    let test = '';
    try {
      math = readFileSync(join(sp.cwd, 'src', 'math.js'), 'utf8');
      test = readFileSync(join(sp.cwd, 'test', 'math.test.js'), 'utf8');
    } catch {
      return;
    }
    if (math !== BUGGY || test !== NEW_TEST) return;
    // The fix's task directory, as its suite runs: git may look nowhere above it.
    const r = spawnSync('git', ['-C', sp.cwd, 'cat-file', '-e', `${w.fix}^{commit}`], { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: dirname(sp.cwd) } });
    const count = spawnSync('git', ['-C', sp.cwd, 'rev-list', '--count', 'HEAD'], { env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: dirname(sp.cwd) }, encoding: 'utf8' });
    seen.push({ git: existsSync(join(sp.cwd, '.git')), commits: String(count.stdout).trim(), fixObject: r.status === 0 });
  };
  const info = await buildPast(w.repo, NOW);
  assert.equal(info.status, 'ready', info.reason ?? '');
  assert.ok(arenaTasks(info.id).some((x) => x.ref === w.fix));
  assert.equal(seen.length, 1, 'the fix was graded at its task base once');
  // A fresh one-commit history of the task state: git works there, and the fix is still out of reach.
  assert.deepEqual(seen[0], { git: true, commits: '1', fixObject: false });
});

test('nothing is fetched beyond the mirror', async () => {
  pastSetUp();
  const w = pastWorld();
  const info = await buildPast(w.repo, NOW);
  assert.equal(info.status, 'ready', info.reason ?? '');
  const gh = calls.filter((c) => c.cmd === 'gh');
  assert.ok(gh.every((c) => c.args[0] === 'pr' && c.args[1] === 'list'), 'gh only lists merged PRs');
  const fetches = calls.filter((c) => c.cmd === 'git' && c.args.some((a) => ['fetch', 'clone', 'pull', 'ls-remote', 'remote'].includes(a)));
  assert.ok(fetches.length > 0, 'the mirror was synced');
  for (const f of fetches) {
    assert.ok(f.args.includes('fetch') && f.args.includes(mirrorDir(FULL)), `only the mirror fetches: ${f.args.join(' ')}`);
  }
  // No clone the build made ever fetched: no FETCH_HEAD, and its origin is the mirror.
  const base = join(paths().runs, `arena-${info.id}`, 'base');
  assert.equal(existsSync(join(base, '.git', 'FETCH_HEAD')), false);
  // Every spawned command was the repo's own test, in a clone of the build.
  for (const s of spawns) assert.ok(s.cwd.startsWith(paths().runs), s.cwd);
});

// ---------------------------------------------------------------- Task 20 fix round 1

test('a red head still builds a past arena, its cap measured from a candidate run', async () => {
  pastSetUp();
  const w = pastWorld({ redHead: true });
  const info = await buildPast(w.repo, NOW);
  assert.equal(info.status, 'ready', info.reason ?? '');
  assert.ok(arenaTasks(info.id).some((x) => x.ref === w.fix), 'the fix is a task though the head is red');
  const grading = gradingSpawns(info.id);
  assert.equal(grading[0].maxMs, CHECK_MS, 'before any candidate passed, a grade has the whole check time');
  const capped = grading.filter((g) => (g.maxMs ?? 0) < CHECK_MS);
  assert.ok(capped.length > 0, 'once a candidate passed, the rest are capped');
  for (const g of capped) assert.ok((g.maxMs ?? 0) >= 60_000, `cap ${g.maxMs}`);
  // The planted arena keeps its rule: a red head fails it.
  const planted = await buildPlanted(w.repo, NOW);
  assert.equal(planted.status, 'failed');
  assert.match(planted.reason ?? '', /do not pass at the head/);
});

test('a change whose dependencies differ from the head is skipped with the reason', async () => {
  pastSetUp();
  const w = pastWorld({ movedDeps: true });
  const info = await buildPast(w.repo, NOW);
  assert.equal(info.status, 'ready', info.reason ?? '');
  const fix = pastCandidatesOf(info.id).find((c) => c.change.sha === w.fix);
  assert.equal(fix?.state, 'skipped');
  assert.match(fix?.reason ?? '', /dependencies differ from the head's \(package\.json\)/);
  assert.ok(!arenaTasks(info.id).some((x) => x.ref === w.fix), 'it is graded on nothing');
  assert.equal(gradingSpawns(info.id).filter((g) => g.cwd.includes(w.fix)).length, 0);
  // A change whose parent has the head's dependencies is still graded and kept.
  assert.ok(arenaTasks(info.id).some((x) => x.ref === w.r1));
});
