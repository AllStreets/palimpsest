/**
 * Arenas as Beagle arenas (Phase 4 Task 21, ruling 21): the tools a racing
 * agent gets and the grade of its answer, both in fresh clones of the arena
 * base under the tool profile with no network. A tiny JS repo with a real
 * `node --test` suite in a temp bare mirror, the sandbox off (test safety
 * rule 7), a temp data home and Beagle's store under its temp school. The
 * models are a fake driver; nothing reaches a real repo, GitHub, the
 * network or Beagle's real home.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { realRunner, realSpawner, setRunner, setSpawner, type Spawner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { execFileTool } from '../engine/market/broker.js';
import { toolProfile } from '../engine/market/sandbox.js';
import type { RunLogLine } from '../engine/market/provider.js';
import * as arenas from '../engine/school/arenas.js';
import type { ArenaTask, PlantedTruth } from '../engine/school/arenas.js';
import type { BeagleArena, BeagleGenome, BeagleToolSpec } from '../engine/school/beagle-api.js';
import { closeBeagle, loadBeagle } from '../engine/school/beagle.js';
import { resetGateCache } from '../engine/school/gate.js';
import { setGate } from '../engine/school/trainer.js';
import { getRepo } from '../engine/repos.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { CHECK_MS } from '../engine/guild/checks.js';
import type { ArenaInfo, GateState, Repo } from '../shared/types.js';
import { addAgent, checks, FULL, git, makeRepo, setUp, tearDown, tempDir } from './guild-fixtures.js';

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
].join('\n');

/** Each failure names the folder it ran in, so a task's output would carry a path of this Mac unless it is scrubbed. */
const SUITE = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { max, isEven } from '../src/math.js';",
  "test('max', () => { assert.equal(max(3, 1), 3, 'in ' + process.cwd()); assert.equal(max(1, 3), 3, 'in ' + process.cwd()); });",
  "test('isEven', () => { assert.equal(isEven(4), true, 'in ' + process.cwd()); assert.equal(isEven(3), false, 'in ' + process.cwd()); });",
  '',
].join('\n');

const BREAK = {
  max: { find: '  if (a > b) return a;', replace: '  if (a > b) return b;' },
  isEven: { find: '  return n % 2 === 0;', replace: '  return n % 2 === 1;' },
};

interface Spawn {
  cmd: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}
let spawns: Spawn[] = [];
let onSpawn: ((s: Spawn) => void) | null = null;

const recording: Spawner = (cmd, args, opts) => {
  const s = { cmd, args, cwd: opts.cwd ?? '', env: { ...(opts.env ?? {}) } };
  spawns.push(s);
  onSpawn?.(s);
  return realSpawner(cmd, args, opts);
};

function gateState(ok: boolean): GateState {
  return { kind: 'heavy', ok, reason: null, power: 'ac', powerMode: 0, idleMin: 60, inWindow: true, trainNowUntil: null, freeGB: 300, thermal: 'nominal' };
}

function tinyRepo(extra: (work: string) => void = () => {}): Repo {
  makeRepo(checks({ test: 'node --test test/math.test.js', install: 'touch installed.txt' }), {
    'package.json': JSON.stringify({ name: 'widgets', type: 'module' }, null, 2),
    'src/math.js': MATH,
    'test/math.test.js': SUITE,
  });
  extra(join(tempDir, 'work', FULL.replace('/', '__')));
  return getRepo(FULL)!;
}

beforeEach(() => {
  setUp('school-arena-grade');
  process.env.BEAGLE_BACKOFF_MS = '0';
  spawns = [];
  onSpawn = null;
  setSpawner(recording);
  setGate(async () => gateState(true));
  patchSettings({ school: { ...getSettings().school, enabled: true } });
});

afterEach(async () => {
  await arenas.releaseArenaViews?.();
  setRunner(realRunner);
  resetGateCache();
  setGate(null);
  closeBeagle();
  delete process.env.BEAGLE_HOME;
  delete process.env.BEAGLE_BACKOFF_MS;
  await tearDown();
});

async function readyArena(): Promise<{ info: ArenaInfo; arena: BeagleArena; tasks: ArenaTask[] }> {
  const info = await arenas.buildPlanted(tinyRepo(), NOW);
  assert.equal(info.status, 'ready', info.reason ?? '');
  const arena = arenas.toBeagleArena(info) as BeagleArena;
  return { info, arena, tasks: arenas.arenaTasks(info.id) };
}

const tool = (a: BeagleArena, name: string): BeagleToolSpec => {
  const t = a.tools.find((x) => x.name === name);
  assert.ok(t, `the arena has ${name}`);
  return t;
};

const ctxOf = (t: ArenaTask) => ({ task: { id: t.id, input: t.input } });

/** A planted task whose bug breaks one test only, with that test's name and the other function's. */
function oneTarget(tasks: ArenaTask[]): { task: ArenaTask; truth: PlantedTruth; other: 'max' | 'isEven' } {
  for (const task of tasks) {
    const truth = task.truth as PlantedTruth;
    if (truth.failing.length !== 1) continue;
    const mutatedFile = MATH.split('\n').map((l, i) => (i === truth.line - 1 ? truth.mutated : l)).join('\n');
    if (mutatedFile.split(truth.mutated).length !== 2) continue;
    const target = truth.failing[0];
    if (target !== 'max' && target !== 'isEven') continue;
    // The other function's line must be untouched by this bug.
    const other = target === 'max' ? 'isEven' : 'max';
    if (!mutatedFile.includes(BREAK[other].find)) continue;
    return { task, truth, other };
  }
  throw new Error('no planted task breaks exactly one test');
}

// ---------------------------------------------------------------- grading

test('a correct edit scores 1, one breaking another test 0.5, an edit to a test file 0', async () => {
  const { arena, tasks } = await readyArena();
  assert.equal(arena.kind, 'fixtest');
  assert.equal(arena.graderTimeoutMs, CHECK_MS);
  assert.equal(arena.graderTimeoutMs, 15 * 60_000);
  assert.equal(arena.maxTurns, 24);
  assert.deepEqual(arena.tools.map((t) => t.name).sort(), ['list_files', 'read_file', 'run_tests', 'search']);

  const { truth, other } = oneTarget(tasks);
  const fix = { file: truth.file, find: truth.mutated, replace: truth.original };
  assert.equal(await arena.grade({ edits: [fix] }, truth), 1, 'the fix mends the target and breaks nothing');
  assert.equal(await arena.grade({ edits: [fix, { file: 'src/math.js', ...BREAK[other] }] }, truth), 0.5, 'the target passes, another test fails');
  assert.equal(await arena.grade({ edits: [] }, truth), 0, 'no change leaves the target failing');
  const toTest = { file: 'test/math.test.js', find: "test('max'", replace: "test.skip('max'" };
  assert.equal(await arena.grade({ edits: [fix, toTest] }, truth), 0, 'an edit to a test file scores 0');
  assert.equal(await arena.grade({ edits: [{ file: 'package.json', find: '"widgets"', replace: '"w"' }] }, truth), 0, 'a file that is not source scores 0');
  assert.equal(await arena.grade(null, truth), 0);
  // every grading clone is gone after
  assert.deepEqual(
    (await import('node:fs')).readdirSync(paths().runs).filter((d) => d.includes('-grade-') || d.includes('-try-')),
    [],
  );
});

test('a non-unique find is refused', async () => {
  const { arena, tasks } = await readyArena();
  const { task, truth } = oneTarget(tasks);
  const before = spawns.length;
  const r = (await tool(arena, 'run_tests').run({ edits: [{ file: 'src/math.js', find: 'return', replace: 'return ' }] }, ctxOf(task))) as { error?: string };
  assert.match(r.error ?? '', /appears \d+ times/);
  assert.equal(spawns.slice(before).filter((s) => s.args.join(' ').includes('node --test')).length, 0, 'no suite ran');
  assert.equal(await arena.grade({ edits: [{ file: 'src/math.js', find: 'return', replace: 'return ' }] }, truth), 0);
  // an edit to a test file is refused by run_tests too
  const t = (await tool(arena, 'run_tests').run({ edits: [{ file: 'test/math.test.js', find: "test('max'", replace: "test.skip('max'" }] }, ctxOf(task))) as { error?: string };
  assert.match(t.error ?? '', /tests may not be changed/);
});

test('two run_tests calls on one task use two scratch clones', async () => {
  const { info, arena, tasks } = await readyArena();
  const { task, truth } = oneTarget(tasks);
  const run = tool(arena, 'run_tests');
  const before = spawns.length;
  const r1 = (await run.run({}, ctxOf(task))) as { passed: boolean; failing: string[]; output: string };
  const r2 = (await run.run({ edits: [{ file: truth.file, find: truth.mutated, replace: truth.original }] }, ctxOf(task))) as { passed: boolean; failing: string[] };
  assert.equal(r1.passed, false);
  assert.deepEqual(r1.failing, truth.failing);
  assert.equal(r2.passed, true, 'the fix passes in its own clone');
  const suites = spawns.slice(before).filter((s) => s.args.join(' ').includes('node --test'));
  assert.equal(suites.length, 2);
  assert.notEqual(suites[0].cwd, suites[1].cwd, 'each call has its own scratch clone');
  for (const s of suites) {
    assert.ok(s.cwd.includes(`arena-${info.id}-try-`), s.cwd);
    assert.equal(existsSync(s.cwd), false, 'the scratch clone is removed after');
  }
  assert.equal(r1.output.includes(tempDir), false, 'run_tests shows no path of this Mac');
});

test('run_tests has no network', async () => {
  const { info, arena, tasks } = await readyArena();
  const before = spawns.length;
  await tool(arena, 'run_tests').run({}, ctxOf(tasks[0]));
  const suites = spawns.slice(before).filter((s) => s.cwd.includes(`arena-${info.id}-try-`));
  assert.ok(suites.length >= 1);
  for (const s of suites) {
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
      assert.match(s.env[k] ?? '', /@127\.0\.0\.1:9$/, `${k} of run_tests is the closed port`);
    }
  }
});

test('show never contains the temp path', async () => {
  const { arena, tasks } = await readyArena();
  const forms = [tempDir, realpathSync(tempDir), paths().runs];
  for (const t of tasks) {
    const shown = arena.show(t.input);
    assert.match(shown, /fail/);
    for (const f of forms) assert.equal(shown.includes(f), false, `show carries ${f}`);
    assert.equal(shown.includes((t.truth as PlantedTruth).mutated.trim()), false, 'show never names the planted line');
  }
  // the read tools see the task's tree, never the path it lives at
  const t = tasks[0];
  const listed = JSON.stringify(await tool(arena, 'list_files').run({}, ctxOf(t)));
  assert.match(listed, /src\/math\.js/);
  assert.doesNotMatch(listed, /\.git\b/, 'list_files leaves out .git');
  for (const f of forms) assert.equal(listed.includes(f), false);
  const read = (await tool(arena, 'read_file').run({ file: 'src/math.js' }, ctxOf(t))) as { lines: string };
  assert.ok(read.lines.includes((t.truth as PlantedTruth).mutated), 'read_file reads the bugged copy');
  const found = JSON.stringify(await tool(arena, 'search').run({ pattern: 'export function' }, ctxOf(t)));
  assert.match(found, /src\/math\.js/);
  assert.doesNotMatch(found, /\.git\//, 'search leaves out .git');
});

test("a race of two fake genomes reads its tasks from Beagle's store", async () => {
  const { info, tasks } = await readyArena();
  const ids = await arenas.registerArenas();
  assert.ok(ids.includes(info.id));
  const b = await loadBeagle();
  const registered = b.arenas.getArena(info.id);
  assert.equal(registered.data, info.id);
  assert.equal(registered.kind, 'fixtest');
  assert.equal(b.race.sealedHash(info.id), info.sealedHash, "the recorded sealedHash is Beagle's, with the real arena registered");

  // Every task races, so the race reads them from Beagle's store whatever their split.
  b.store.open().prepare("UPDATE tasks SET split = 'race' WHERE arena = ?").run(info.id);
  const byShow = new Map(tasks.map((t) => [registered.show(t.input), t]));
  const asked: string[] = [];
  b.models.setDriver(async (_p, name, turns) => {
    const shown = turns.find((t) => t.role === 'user')?.content ?? '';
    asked.push(shown);
    const t = byShow.get(shown);
    const truth = t?.truth as PlantedTruth | undefined;
    const edits = name === 'fixer' && truth ? [{ file: truth.file, find: truth.mutated, replace: truth.original }] : [];
    return { text: JSON.stringify({ action: 'answer', answer: { edits } }), usd: 0, ms: 1 };
  });
  const v = b.race.startVoyage(info.id, { concurrency: 1, raceTasks: 2, localOnly: true });
  const g = (id: string, model: string): BeagleGenome => ({ id, name: id, model, instructions: 'Fix the bug.', tools: [], workflow: { shape: 'single' }, memory: { examples: 0 } });
  const r = await b.race.race(v.id, 1, [g('fixer', 'ollama:fixer'), g('blank', 'ollama:blank')], { baselines: false });
  assert.equal(r.complete, true, r.reason ?? '');
  assert.equal(r.common.length, 2);
  for (const id of r.common) assert.ok(tasks.some((t) => t.id === id), 'a raced task is one of the arena\'s');
  assert.ok(asked.every((s) => byShow.has(s)), 'every model saw a task shown from its stored input');
  const score = (id: string) => r.scores.find((s) => s.genome === id)?.mean;
  assert.equal(score('fixer'), 1);
  assert.equal(score('blank'), 0);
});

test('starters are the seeded local agents as genomes with the arena\'s tools', async () => {
  const { arena } = await readyArena();
  const b = await loadBeagle();
  addAgent('local-seed', 'quill', 'ollama:qwen2.5-coder:7b', { tools: ['read', 'edit', 'write', 'glob', 'grep', 'run'], workflow: { shape: 'self-check' }, memory: { examples: 3 } });
  addAgent('claude-seed', 'quill', 'claude:sonnet', { tools: ['read', 'run'] });
  addAgent('local-roster', 'quill', 'ollama:llama3.1:8b', { lineage: { origin: 'roster', parents: [], generation: 0, at: '2026-11-01T00:00:00.000Z' } });
  addAgent('local-retired', 'quill', 'ollama:llama3.1:8b', { retired: true, retiredReason: 'not installed' });
  const starters = arena.starters?.() ?? [];
  assert.deepEqual(starters.map((s) => s.id), ['local-seed']);
  const s = starters[0];
  assert.equal(s.model, 'ollama:qwen2.5-coder:7b');
  assert.deepEqual([...s.tools].sort(), ['list_files', 'read_file', 'run_tests', 'search']);
  assert.deepEqual(s.workflow, { shape: 'self-check' });
  assert.equal(s.memory.examples, 3);
  b.genome.validate(s, arena.tools.map((t) => t.name));
});

// ---------------------------------------------------------------- the pin

test('read_file outside the clone and through a symlink is refused', async () => {
  const runRoot = join(paths().runs, 'pin-read');
  const dir = join(runRoot, 'repo');
  for (const d of ['repo/src', 'tmp', 'home', 'cache', 'ctl']) mkdirSync(join(runRoot, d), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.js'), 'export const a = 1;\n');
  const secret = join(tempDir, 'secret.txt');
  writeFileSync(secret, 'his secret\n');
  symlinkSync(secret, join(dir, 'src', 'link.js'));
  symlinkSync(tempDir, join(dir, 'up'));
  const o = { runId: 'pin-read', runRoot, dir, signal: new AbortController().signal, log: (_l: RunLogLine) => {} };
  for (const path of ['../../../secret.txt', secret, 'src/link.js', 'up/secret.txt']) {
    const r = await execFileTool({ ...o, op: 'read', args: { path } });
    assert.ok(r.refused, `${path} is refused`);
    assert.doesNotMatch(r.stdout, /his secret/);
  }
  const ok = await execFileTool({ ...o, op: 'read', args: { path: 'src/a.js' } });
  assert.equal(ok.refused, null);
  assert.equal(readFileSync(secret, 'utf8'), 'his secret\n');
});

test("the arena's file tools refuse a path outside the task's clone or through a link", async () => {
  const secret = join(tempDir, 'victim.js');
  writeFileSync(secret, 'his secret\n');
  const repo = tinyRepo((work) => {
    symlinkSync(secret, join(work, 'src', 'link.js'));
    symlinkSync(tempDir, join(work, 'lib'));
    git(work, 'add', '.');
    git(work, 'commit', '-q', '-m', 'links');
  });
  const info = await arenas.buildPlanted(repo, NOW);
  assert.equal(info.status, 'ready', info.reason ?? '');
  const arena = arenas.toBeagleArena(info) as BeagleArena;
  const t = arenas.arenaTasks(info.id)[0];
  const refusedRead = async (file: string) => {
    const r = JSON.stringify(await tool(arena, 'read_file').run({ file }, ctxOf(t)));
    assert.match(r, /refused|error/, `${file}: ${r}`);
    assert.doesNotMatch(r, /his secret/, file);
  };
  for (const f of ['src/link.js', 'lib/victim.js', '../../../victim.js', secret, '.git/config']) await refusedRead(f);
  for (const name of ['list_files', 'search']) {
    const r = JSON.stringify(await tool(arena, name).run({ path: 'lib', pattern: 'secret' }, ctxOf(t)));
    assert.match(r, /refused|error/, `${name} through a link: ${r}`);
    assert.doesNotMatch(r, /his secret/);
  }
  const all = JSON.stringify(await tool(arena, 'search').run({ pattern: 'secret' }, ctxOf(t)));
  assert.doesNotMatch(all, /his secret/, 'a search of the whole tree never follows a link');
  assert.equal(readFileSync(secret, 'utf8'), 'his secret\n');
});

// ---------------------------------------------------------------- fix round 1

/** A loose tree for applyEdits alone: no arena, no suite. */
function looseTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tempDir, 'loose-'));
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  return dir;
}

const edit = (file: string) => [{ file, find: 'x', replace: 'y' }];

test('a test file in any spelling is refused, and a source file only in its own spelling', () => {
  const dir = looseTree({ 'src/math.js': 'x\n', 'test/math.test.js': 'x\n', 'Tests/helper.js': 'x\n', '__Tests__/helper.js': 'x\n', 'Spec/util.js': 'x\n' });
  const command = 'node --test test/math.test.js';
  for (const f of ['Test/math.test.js', 'TEST/MATH.TEST.JS', 'test/Math.Test.js', 'Tests/helper.js', 'TESTS/helper.js', 'tests/helper.js', '__Tests__/helper.js', '__TESTS__/helper.js', 'Spec/util.js']) {
    assert.equal(arenas.applyEdits(dir, edit(f), command), 'the tests may not be changed', f);
  }
  assert.match(arenas.applyEdits(dir, edit('src/Math.js'), command) ?? '', /in that spelling/, 'a source file asked for in another case');
  assert.match(arenas.applyEdits(dir, edit('SRC/math.js'), command) ?? '', /in that spelling/);
  for (const f of ['test/math.test.js', 'Tests/helper.js', '__Tests__/helper.js', 'Spec/util.js', 'src/math.js']) assert.equal(readFileSync(join(dir, f), 'utf8'), 'x\n', `${f} is unchanged`);
  assert.equal(arenas.applyEdits(dir, edit('src/math.js'), command), null);
  assert.equal(readFileSync(join(dir, 'src/math.js'), 'utf8'), 'y\n');
});

test('test configuration, runner files and whatever the test command names are refused', () => {
  const files = [
    'conftest.py', 'pkg/conftest.py', 'jest.config.js', 'vite.config.ts', 'Vitest.Config.mts', '.mocharc.js', '.eslintrc.cjs', 'setupTests.js', 'setup.py', 'vitest.setup.ts',
    'karma.conf.js', 'jest.setup.js', 'run.sh', 'scripts/ci.sh', 'package.json', 'e2e/flow.js', 'src/__mocks__/fs.js', 'fixtures/data.js', 'src/fixtures/data.ts', 'scripts/check.js', 'tools/runner/main.js',
  ];
  const dir = looseTree(Object.fromEntries([...files, 'src/math.js'].map((f) => [f, 'x\n'])));
  const command = 'node scripts/check.js && node --test --import=./tools/runner test/';
  for (const f of files) assert.match(arenas.applyEdits(dir, edit(f), command) ?? '', /may not be changed/, f);
  for (const f of files) assert.equal(readFileSync(join(dir, f), 'utf8'), 'x\n', `${f} is unchanged`);
  assert.equal(arenas.applyEdits(dir, edit('src/math.js'), command), null, 'a plain source file may be edited');
});

test('a source edit that exits 0 before the tests run does not score 1', async () => {
  const { arena, tasks } = await readyArena();
  const { truth } = oneTarget(tasks);
  const fix = { file: truth.file, find: truth.mutated, replace: truth.original };
  const exitEarly = { file: 'src/math.js', find: 'export function isEven', replace: 'process.exit(0);\nexport function isEven' };
  assert.equal(await arena.grade({ edits: [exitEarly] }, truth), 0, 'the suite exits 0 but no target is seen passing');
  assert.equal(await arena.grade({ edits: [fix, exitEarly] }, truth), 0, 'even with the fix, the targets never ran');
  assert.equal(await arena.grade({ edits: [fix] }, truth), 1);
});

test('a source file that writes a test file at import fails the grade', async () => {
  const { arena, tasks } = await readyArena();
  const { task, truth } = oneTarget(tasks);
  const fix = { file: truth.file, find: truth.mutated, replace: truth.original };
  const tamper = {
    file: 'src/math.js',
    find: 'export function isEven',
    replace: "import { writeFileSync as __w } from 'node:fs';\n__w(new URL('../test/math.test.js', import.meta.url), '// nothing to test\\n');\nexport function isEven",
  };
  assert.equal(await arena.grade({ edits: [fix, tamper] }, truth), 0);
  const r = (await tool(arena, 'run_tests').run({ edits: [fix, tamper] }, ctxOf(task))) as { passed: boolean; error?: string; output?: string };
  assert.equal(r.passed, false);
  // With the sandbox off the write lands and is caught after the run; under it the profile refuses the write itself.
  assert.ok(/test\/math\.test\.js/.test(r.error ?? '') || /EPERM|not permitted/.test(r.output ?? ''), JSON.stringify(r).slice(0, 600));
  // Under the sandbox the profile denies the write itself.
  const runRoot = join(paths().runs, 'profile-check');
  mkdirSync(runRoot, { recursive: true });
  const text = toolProfile({ runRoot, home: tempDir, dataHome: join(tempDir, 'home'), enginePort: 4770, proxyPort: 9, toolchains: [], otherPorts: [], readOnly: ['/x/repo/test/math.test.js', '/x/repo/package.json'] });
  assert.match(text, /\(deny file-write\* \(literal "\/x\/repo\/test\/math\.test\.js"\) \(literal "\/x\/repo\/package\.json"\)\)/);
  assert.ok(text.lastIndexOf('(deny file-write* (literal "/x/repo/test/math.test.js")') > text.indexOf('(allow file-write*'), 'the deny comes after the allows');
});

test('each task copy is one fresh commit of the task, and the head is out of reach', async () => {
  const { info, arena, tasks } = await readyArena();
  const { task, truth } = oneTarget(tasks);
  const seen: Array<{ commits: string; head: boolean; buggy: boolean; clean: boolean }> = [];
  const env = { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  onSpawn = (sp) => {
    if (!sp.cwd.includes(`arena-${info.id}-try-`) && !sp.cwd.includes(`arena-${info.id}-grade-`)) return;
    const g = (...args: string[]) => spawnSync('git', ['-C', sp.cwd, ...args], { env: { ...env, GIT_CEILING_DIRECTORIES: dirname(sp.cwd) }, encoding: 'utf8' });
    seen.push({
      commits: g('rev-list', '--count', 'HEAD').stdout.trim(),
      head: g('cat-file', '-e', `${info.sha}^{commit}`).status === 0,
      buggy: g('show', `HEAD:${truth.file}`).stdout.includes(truth.mutated),
      clean: g('status', '--porcelain', '--untracked-files=no').stdout.trim() === '',
    });
  };
  await tool(arena, 'run_tests').run({}, ctxOf(task));
  await arena.grade({ edits: [{ file: truth.file, find: truth.mutated, replace: truth.original }] }, truth);
  assert.equal(seen.length, 2);
  for (const x of seen) {
    assert.equal(x.commits, '1', 'one commit');
    assert.equal(x.head, false, 'the head (the bug-free code) is unreachable');
    assert.equal(x.buggy, true, 'the commit is the task state, bug and all');
  }
  assert.equal(seen[0].clean, true, 'run_tests with no edits runs the commit as it is');
  assert.equal(seen[1].clean, false, 'the grade runs the racer\'s edits on top of it');
});
