/**
 * The LoRA dataset (Phase 4 Task 24, ruling 23): his verified past work as
 * chat examples in the arena's shape. GitHub is a temp bare repo the mirror
 * is cloned from and a fake runner answering `gh pr list`; sealed tasks are
 * rows written straight into `arena_tasks`. Temp home only; nothing reaches
 * a real repo, the network or a model.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { realRunner, setRunner, type Runner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { mirrorDir } from '../engine/mirror.js';
import { getRepo } from '../engine/repos.js';
import { buildLoraData, estimateTokens, hunksToEdits, secretPath, type LoraExample } from '../engine/school/lora.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import { LORA } from '../shared/school-rules.js';
import type { Repo } from '../shared/types.js';
import { checks, FULL, setUp, tearDown, tempDir } from './guild-fixtures.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 10, 12, 3, 0).getTime();
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

let prs: object[] = [];
let gitCalls: string[][] = [];

const fake: Runner = async (cmd, args, opts) => {
  const base = cmd.split('/').pop() ?? cmd;
  if (base === 'gh') {
    if (args[0] === 'pr' && args[1] === 'list') return { stdout: JSON.stringify(prs), stderr: '', code: 0 };
    return { stdout: '', stderr: `unexpected gh ${args.join(' ')}`, code: 1 };
  }
  if (base === 'git') {
    gitCalls.push(args);
    return realRunner(cmd, args, opts);
  }
  return { stdout: '', stderr: `unexpected ${base}`, code: 1 };
};

function gitAt(cwd: string, date: string, ...args: string[]): string {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(work: string, days: number, files: Record<string, string>, message: string): string {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(work, name)), { recursive: true });
    writeFileSync(join(work, name), text);
  }
  gitAt(work, ago(days), 'add', '-A');
  gitAt(work, ago(days), 'commit', '-q', '-m', message);
  return gitAt(work, ago(days), 'rev-parse', 'HEAD');
}

const UTIL = 'export function a() {\n  return 1;\n}\nexport function b() {\n  return 1;\n}\n';
const UTIL_AFTER = 'export function a() {\n  return 1;\n}\nexport function b() {\n  return 2;\n}\n';
/** 30 KB: over LORA.maxFileBytes. */
const BIG = Array.from({ length: 750 }, (_, i) => `export const big${String(i).padStart(4, '0')} = 'abcdefghijklmnop';\n`).join('');
/** 20 KB: under the byte cap, over 4,096 tokens once shown. */
const LONG = Array.from({ length: 500 }, (_, i) => `export const v${String(i).padStart(4, '0')} = 'abcdefghijklmnopq';\n`).join('');

interface World {
  repo: Repo;
  util: string;
  big: string;
  long: string;
  prMerge: string;
  prSide: string;
  sealedCommit: string;
  link: string;
  small: string[];
}

function world(extra?: (work: string) => void): World {
  const repo: Repo = {
    fullName: FULL,
    private: false,
    defaultBranch: 'main',
    language: 'TypeScript',
    description: null,
    connected: true,
    pushMode: false,
    root: 'gothic',
    slot: 0,
    status: 'ready',
    error: null,
    connectedAt: '2026-01-01T00:00:00.000Z',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    ...repoMarketDefaults(),
    market: true,
    joinedAt: '2026-01-01T00:00:00.000Z',
    checks: checks({ test: null }),
  };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(repo.fullName, JSON.stringify(repo));
  const work = join(tempDir, 'his-work');
  mkdirSync(work, { recursive: true });
  gitAt(work, ago(200), 'init', '-q', '-b', 'main');
  const root: Record<string, string> = { 'README.md': 'widgets\n', 'src/util.ts': UTIL, 'src/big.ts': BIG, 'src/long.ts': LONG, 'src/p.ts': 'export const p = 1;\n', 'src/q.ts': 'export const q = 1;\n', 'src/s.ts': 'export const s = 1;\n' };
  for (let i = 0; i < 10; i++) root[`src/n${i}.ts`] = `export const n${i} = 1;\n`;
  commit(work, 200, root, 'first');
  const util = commit(work, 150, { 'src/util.ts': UTIL_AFTER, 'test/util.test.ts': "test('b is 2', () => {});\n" }, 'Make b answer two\n\nThe callers want two.');
  const big = commit(work, 140, { 'src/big.ts': BIG.replace('big0001', 'big0001b') }, 'Rename one big constant');
  const long = commit(work, 130, { 'src/long.ts': LONG.replace("v0007 = 'abcdefghijklmnopq'", "v0007 = 'changed'") }, 'Change one long constant');
  gitAt(work, ago(121), 'checkout', '-q', '-b', 'feature');
  const prSide = commit(work, 121, { 'src/p.ts': 'export const p = 2;\n' }, 'Make p two');
  gitAt(work, ago(120), 'checkout', '-q', 'main');
  gitAt(work, ago(120), 'merge', '-q', '--no-ff', '-m', 'Merge pull request #5 from acme/feature', 'feature');
  const prMerge = gitAt(work, ago(120), 'rev-parse', 'HEAD');
  const sealedCommit = commit(work, 115, { 'src/q.ts': 'export const q = 2;\n' }, 'Make q two');
  symlinkSync('util.ts', join(work, 'src', 'alias.ts'));
  const link = commit(work, 105, { 'src/s.ts': 'export const s = 2;\n' }, 'Make s two and alias util');
  const small: string[] = [];
  for (let i = 0; i < 10; i++) small.push(commit(work, 100 - i, { [`src/n${i}.ts`]: `export const n${i} = 2;\n` }, `Make n${i} two`));
  extra?.(work);
  const remote = join(tempDir, 'github', 'acme__widgets.git');
  mkdirSync(dirname(remote), { recursive: true });
  gitAt(tempDir, ago(0), 'clone', '-q', '--bare', work, remote);
  mkdirSync(paths().mirrors, { recursive: true });
  gitAt(tempDir, ago(0), 'clone', '-q', '--bare', remote, mirrorDir(FULL));
  prs = [{ number: 5, title: 'Make p two', mergedAt: ago(120), mergeCommit: { oid: prMerge }, url: `https://github.com/${FULL}/pull/5`, headRefName: 'feature' }];
  return { repo: getRepo(FULL)!, util, big, long, prMerge, prSide, sealedCommit, link, small };
}

/** A sealed past task, as Task 20 writes it. */
function sealTask(id: string, ref: string, truth: { ref: string; sha: string; commits: string[] }): void {
  openDb()
    .prepare('INSERT INTO arena_tasks (id, arena, split, ref, json) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'arena-x', 'sealed', ref, JSON.stringify({ id, arena: 'arena-x', split: 'sealed', ref, input: {}, truth: { kind: 'past', parent: '', testFiles: [], sourceFiles: [], failing: [], fix: '', ...truth } }));
}

/** Applies edits the way the arena does: each find exactly once, replaced whole. */
function applyAll(text: string, edits: Array<{ find: string; replace: string }>): string {
  let s = text;
  for (const e of edits) {
    assert.ok(e.find.length > 0, 'a find is never empty');
    assert.equal(s.split(e.find).length - 1, 1, `find appears once: ${JSON.stringify(e.find)}`);
    s = s.replace(e.find, () => e.replace);
  }
  return s;
}

const shaOf = (e: LoraExample) => e.sha;
const readJsonl = (p: string) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { messages: Array<{ role: string; content: string }> });

beforeEach(() => {
  setUp('school-lora-data');
  prs = [];
  gitCalls = [];
  setRunner(fake);
  patchSettings({ school: { ...getSettings().school, enabled: true, commitsAsWork: true } });
});

afterEach(async () => {
  setRunner(realRunner);
  await tearDown();
});

test('hunksToEdits widens a repeated line until unique and reproduces the after text', () => {
  const patch = '--- a/src/util.ts\n+++ b/src/util.ts\n@@ -5 +5 @@ export function b() {\n-  return 1;\n+  return 2;\n';
  const edits = hunksToEdits(UTIL, patch);
  assert.ok(edits, 'the patch becomes edits');
  assert.equal(edits.length, 1);
  assert.notEqual(edits[0].find, '  return 1;\n', 'the repeated line alone is not unique');
  assert.equal(UTIL.split(edits[0].find).length - 1, 1, 'the widened find is unique');
  assert.equal(applyAll(UTIL, edits), UTIL_AFTER);

  // A real git patch with several hunks, an insertion with no context and a last line with no newline.
  const before = Array.from({ length: 40 }, (_, i) => (i % 5 === 0 ? '}\n' : `line ${i}\n`)).join('') + 'end';
  const after = before.replace('line 3\n', 'line three\n').replace('line 21\n', 'line 21\n}\nnew\n').replace(/end$/, 'the end\n');
  const dir = join(tempDir, 'hunks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'a'), before);
  writeFileSync(join(dir, 'b'), after);
  for (const u of ['-U0', '-U3']) {
    const r = spawnSync('git', ['diff', '--no-index', u, 'a', 'b'], { cwd: dir, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    const got = hunksToEdits(before, r.stdout);
    assert.ok(got, `${u} becomes edits`);
    assert.equal(applyAll(before, got), after, `${u} reproduces the after text`);
  }

  // Nothing to anchor on: a file created from nothing, or a patch that does not fit the before text.
  assert.equal(hunksToEdits('', '@@ -0,0 +1 @@\n+x\n'), null);
  assert.equal(hunksToEdits(UTIL, '@@ -5 +5 @@\n-  return 9;\n+  return 2;\n'), null);
});

test('each verified change is an example and a sealed one is skipped as sealed', async () => {
  const w = world();
  // A merge PR sealed only through its inner commit, and a direct commit sealed by its task ref.
  sealTask('arena-x:1', 'other', { ref: `commit:${w.prSide}`, sha: w.prSide, commits: [w.prSide] });
  sealTask('arena-x:2', w.sealedCommit, { ref: `commit:${w.sealedCommit}`, sha: w.sealedCommit, commits: [w.sealedCommit] });
  const got = await buildLoraData(NOW);
  const shas = got.examples.map(shaOf);
  assert.ok(!shas.includes(w.prMerge), "the PR whose inner commit is sealed is not an example");
  assert.ok(!shas.includes(w.sealedCommit), 'the sealed commit is not an example');
  assert.equal(got.skipped.sealed, 2);
  assert.deepEqual(shas, [w.util, w.link, ...w.small], 'every other verified change is an example, oldest first');

  const util = got.examples.find((e) => e.sha === w.util)!;
  assert.equal(util.ref, `commit:${w.util}`);
  assert.equal(util.repo, FULL);
  const [sys, user, ...rest] = util.messages;
  assert.equal(sys.role, 'system');
  assert.match(sys.content, /Reply with JSON only\./);
  assert.match(sys.content, /"action": "answer"/);
  assert.match(sys.content, /read_file/);
  assert.equal(user.role, 'user');
  assert.match(user.content, /Make b answer two/);
  assert.match(user.content, /The callers want two\./);
  assert.match(user.content, /test\/util\.test\.ts/, 'the tests it added are shown');
  // read_file of the source file, its result, then the answer.
  assert.deepEqual(rest.map((m) => m.role), ['assistant', 'user', 'assistant']);
  assert.deepEqual(JSON.parse(rest[0].content), { action: 'read_file', args: { file: 'src/util.ts' } });
  assert.match(rest[1].content, /^Result of read_file: /);
  assert.match(rest[1].content, /5:   return 1;/);
  const answer = JSON.parse(rest[2].content) as { action: string; answer: { edits: Array<{ file: string; find: string; replace: string }> } };
  assert.equal(answer.action, 'answer');
  assert.ok(answer.answer.edits.every((e) => e.file === 'src/util.ts'), 'only source is edited, never the test');
  assert.equal(applyAll(UTIL, answer.answer.edits), UTIL_AFTER);

  const link = got.examples.find((e) => e.sha === w.link)!;
  const text = link.messages.map((m) => m.content).join('\n');
  assert.ok(!text.includes('alias.ts'), 'a symlinked file is never read nor edited');
  assert.match(text, /src\/s\.ts/);
  assert.ok(!gitCalls.some((a) => a.join(' ').includes('alias.ts')), 'git never reads the link by name');
});

test('a 30 KB file skips the change', async () => {
  const w = world();
  assert.ok(Buffer.byteLength(BIG) > LORA.maxFileBytes);
  const got = await buildLoraData(NOW);
  assert.ok(!got.examples.map(shaOf).includes(w.big));
  assert.equal(got.skipped['too-large'], 1);
});

test('an example over 4,096 tokens is skipped', async () => {
  const w = world();
  assert.ok(Buffer.byteLength(LONG) < LORA.maxFileBytes);
  const got = await buildLoraData(NOW);
  assert.ok(!got.examples.map(shaOf).includes(w.long));
  assert.equal(got.skipped['too-long'], 1);
  assert.ok(got.examples.every((e) => e.tokens <= LORA.maxSeq && e.tokens === estimateTokens(e.messages)));
});

test('the latest 10% go to valid.jsonl', async () => {
  const w = world();
  const got = await buildLoraData(NOW);
  assert.equal(got.examples.length, 14);
  const train = readJsonl(got.path);
  const valid = readJsonl(got.validPath);
  assert.equal(valid.length, 1, 'one in ten, rounded, is held for validation');
  assert.equal(train.length, 13);
  const last = got.examples.at(-1)!;
  assert.equal(last.sha, w.small[9], 'the newest change');
  assert.deepEqual(valid[0], { messages: last.messages });
  assert.deepEqual(train, got.examples.slice(0, 13).map((e) => ({ messages: e.messages })));
});

test('the data stays under paths().school', async () => {
  world();
  const got = await buildLoraData(NOW);
  const school = realpathSync(paths().school);
  for (const p of [got.path, got.validPath]) {
    assert.ok(existsSync(p));
    assert.ok(realpathSync(p).startsWith(`${school}/lora/`), `${p} is under the school`);
  }
  assert.equal(dirname(got.path), dirname(got.validPath));
  assert.deepEqual(readdirSync(dirname(got.path)).sort(), ['train.jsonl', 'valid.jsonl']);
  assert.ok(school.startsWith(realpathSync(tempDir)), 'the school is the temp home');
});

test('a token in a test diff or a commit message, or a .env change, is skipped as secret', async () => {
  const token = `ghp_${'aB3'.repeat(12)}`;
  let inTest = '';
  let inMessage = '';
  let env = '';
  let plain = '';
  const w = world((work) => {
    inTest = commit(work, 60, { 'src/n0.ts': 'export const n0 = 3;\n', 'test/n0.test.ts': `const t = '${token}';\n` }, 'Make n0 three');
    inMessage = commit(work, 58, { 'src/n1.ts': 'export const n1 = 3;\n' }, `Make n1 three\n\nUsed ${token} to check.`);
    env = commit(work, 56, { 'src/n2.ts': 'export const n2 = 3;\n', 'config/.env.local': 'A=1\n' }, 'Make n2 three');
    plain = commit(work, 54, { 'src/n3.ts': 'export const n3 = 3;\n' }, 'Make n3 three');
  });
  gitCalls = [];
  const got = await buildLoraData(NOW);
  const shas = got.examples.map(shaOf);
  for (const s of [inTest, inMessage, env]) assert.ok(!shas.includes(s), 'a change with a secret is no example');
  assert.equal(got.skipped.secret, 3);
  assert.ok(shas.includes(plain), 'an ordinary change still becomes an example');
  assert.ok(shas.includes(w.small[0]));
  const text = [readFileSync(got.path, 'utf8'), readFileSync(got.validPath, 'utf8')].join('');
  assert.ok(!text.includes(token), 'the token is nowhere in the data');
  assert.ok(!text.includes('.env'), 'the .env change is nowhere in the data');
  assert.ok(!gitCalls.some((a) => a.join(' ').includes('.env')), 'the .env file is never read');

  for (const p of ['.env', 'a/.env.production', 'certs/server.pem', 'k/tls.KEY', 'id_rsa.pub', 'credentials.json', 'secrets.yaml', 'home/.ssh/config', 'x/.aws/credentials', '.npmrc', '.netrc', '.git-credentials', 'cert.p12', 'dot/.config/gh/hosts.yml', '.docker/config.json', '.gnupg/k']) {
    assert.ok(secretPath(p), `${p} is secret`);
  }
  for (const p of ['src/env.ts', 'src/keyboard.ts', 'src/config/gh.ts', 'src/secret_sauce.ts', 'environment.md']) assert.ok(!secretPath(p), `${p} is not secret`);
});
