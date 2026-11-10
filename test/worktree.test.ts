import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, cpSync, existsSync, realpathSync, renameSync, symlinkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import type { Repo } from '../shared/types.js';
import { mirrorDir } from '../engine/mirror.js';
import { childEnv } from '../engine/market/sandbox.js';
import { commitAll, controlFiles, createRunDir, diffOf, engineGit, removeRunDir } from '../engine/market/worktree.js';

let tempDir: string;
let previousHome: string | undefined;

const GIT_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

function sh(cmd: string, args: string[], cwd: string, env: Record<string, string> = GIT_ENV) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function gitIn(cwd: string, ...args: string[]): string {
  const r = sh('git', args, cwd);
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const repo = { fullName: 'owner/name', defaultBranch: 'main' } as Repo;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-worktree-test-'));
  process.env.PALIMPSEST_HOME = join(tempDir, 'data');
  // A working repo, then its bare mirror where syncMirror would put it.
  const work = join(tempDir, 'work');
  mkdirSync(work);
  gitIn(work, 'init', '-q', '-b', 'main');
  writeFileSync(join(work, 'README.md'), 'one\ntwo\n');
  gitIn(work, 'add', '.');
  gitIn(work, 'commit', '-q', '-m', 'first');
  gitIn(tempDir, 'clone', '-q', '--bare', work, mirrorDir(repo.fullName));
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PALIMPSEST_HOME;
  else process.env.PALIMPSEST_HOME = previousHome;
  rmSync(tempDir, { recursive: true, force: true });
});

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
}

test('createRunDir clones without hardlinks on the branch with origin fetch rewritten and push invalid', async () => {
  const { runRoot, dir, baseSha } = await createRunDir(repo, 'run1', 'palimpsest/job1');
  for (const d of ['repo', 'tmp', 'home', 'cache', 'ctl']) assert.ok(statSync(join(runRoot, d)).isDirectory(), d);
  assert.equal(gitIn(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'palimpsest/job1');
  assert.equal(gitIn(dir, 'rev-parse', 'HEAD'), baseSha);
  assert.equal(gitIn(mirrorDir(repo.fullName), 'rev-parse', 'main'), baseSha);
  assert.equal(gitIn(dir, 'remote', 'get-url', 'origin'), 'https://github.com/owner/name.git');
  assert.equal(gitIn(dir, 'remote', 'get-url', '--push', 'origin'), 'no-push://palimpsest');
  const objects = filesUnder(join(dir, '.git', 'objects'));
  assert.ok(objects.length > 0);
  for (const f of objects) assert.equal(statSync(f).nlink, 1, `${f} is hardlinked`);
  const ctl = controlFiles('run1');
  assert.equal(readFileSync(ctl.gitconfig, 'utf8'), '');
  assert.equal(readFileSync(ctl.npmrc, 'utf8'), '');
  const sha = createHash('sha256').update(readFileSync(join(dir, '.git', 'config'))).digest('hex');
  assert.equal(readFileSync(ctl.gitConfigSha, 'utf8').trim(), sha);
  assert.ok(!existsSync(join(dir, 'ctl')), 'control files stay outside the repo dir');
});

test('a push from the run dir fails', async () => {
  const { runRoot, dir } = await createRunDir(repo, 'run1', 'palimpsest/job1');
  writeFileSync(join(dir, 'x.txt'), 'x\n');
  gitIn(dir, 'add', '.');
  gitIn(dir, 'commit', '-q', '-m', 'x');
  const env = childEnv(runRoot, { proxyPort: 9, proxyToken: 't', toolchains: [] });
  const r = sh('git', ['push', 'origin', 'HEAD'], dir, env);
  assert.notEqual(r.code, 0);
  const r2 = sh('git', ['push', 'origin', 'HEAD:main', '--force'], dir, env);
  assert.notEqual(r2.code, 0);
  // His global credential helper is never loaded: a helper in the fake home's .gitconfig is shadowed by the empty per-run file.
  writeFileSync(join(runRoot, 'home', '.gitconfig'), '[credential]\n\thelper = !/opt/homebrew/bin/gh auth git-credential\n');
  const helper = sh('git', ['config', '--get-regexp', '^credential'], dir, env);
  assert.equal(helper.code, 1, helper.stdout);
  // The mirror never moved.
  assert.notEqual(gitIn(mirrorDir(repo.fullName), 'rev-parse', 'main'), gitIn(dir, 'rev-parse', 'HEAD'));
});

test('engineGit refuses after .git/config changes', async () => {
  const { dir } = await createRunDir(repo, 'run1', 'palimpsest/job1');
  assert.equal((await engineGit(dir, ['status', '--short'])).code, 0);
  appendFileSync(join(dir, '.git', 'config'), '[core]\n\tfsmonitor = /bin/echo\n');
  await assert.rejects(engineGit(dir, ['status']), /run dir git config changed/);
  await assert.rejects(commitAll(dir, 'm', 'job1'), /run dir git config changed/);
});

test('engineGit refuses when .git/config is replaced by a symlink', async () => {
  const { dir } = await createRunDir(repo, 'run1', 'palimpsest/job1');
  const copy = join(tempDir, 'config-copy');
  writeFileSync(copy, readFileSync(join(dir, '.git', 'config')));
  rmSync(join(dir, '.git', 'config'));
  spawnSync('/bin/ln', ['-s', copy, join(dir, '.git', 'config')]);
  await assert.rejects(engineGit(dir, ['status']), /run dir git config changed/);
});

test('the engine refuses a planted commondir, gitdir or config.worktree and runs no filter it names', async () => {
  for (const planted of ['commondir', 'gitdir', 'config.worktree']) {
    const runId = `run-${planted.replace('.', '-')}`;
    const { runRoot, dir, baseSha } = await createRunDir(repo, runId, 'palimpsest/job1');
    const marker = join(tempDir, `MARKER-${planted}`);
    // A common dir whose config defines a clean filter, as the rename trick would plant it.
    const evil = join(runRoot, 'tmp', 'evil');
    cpSync(join(dir, '.git'), evil, { recursive: true });
    appendFileSync(join(evil, 'config'), `[filter "x"]\n\tclean = touch ${marker}; cat\n[core]\n\tworktree = ${tempDir}\n`);
    if (planted === 'config.worktree') writeFileSync(join(dir, '.git', planted), `[filter "x"]\n\tclean = touch ${marker}; cat\n`);
    else writeFileSync(join(dir, '.git', planted), evil + '\n');
    writeFileSync(join(dir, '.gitattributes'), '* filter=x\n');
    writeFileSync(join(dir, 'b.txt'), 'b\n');
    await assert.rejects(diffOf(dir, baseSha), /run dir git layout changed/, planted);
    await assert.rejects(commitAll(dir, 'm', 'job1'), /run dir git layout changed/, planted);
    await assert.rejects(engineGit(dir, ['status']), /run dir git layout changed/, planted);
    assert.ok(!existsSync(marker), `${planted}: the engine ran attacker code`);
  }
});

test('the engine refuses when the repo dir or its .git is a symlink', async () => {
  const { runRoot, dir } = await createRunDir(repo, 'run1', 'palimpsest/job1');
  // .git swapped for a symlink to an identical copy (same config hash).
  const copy = join(runRoot, 'tmp', 'gitcopy');
  cpSync(join(dir, '.git'), copy, { recursive: true });
  rmSync(join(dir, '.git'), { recursive: true });
  symlinkSync(copy, join(dir, '.git'));
  await assert.rejects(engineGit(dir, ['status']), /run dir git layout changed/);
  rmSync(join(dir, '.git'));
  cpSync(copy, join(dir, '.git'), { recursive: true });
  assert.equal((await engineGit(dir, ['status', '--short'])).code, 0);
  // The repo dir itself swapped for a symlink to a moved copy.
  const moved = join(runRoot, 'tmp', 'moved');
  renameSync(dir, moved);
  symlinkSync(moved, dir);
  await assert.rejects(engineGit(dir, ['status']), /run dir git layout changed/);
  await assert.rejects(diffOf(dir, 'HEAD'), /run dir git layout changed/);
});

test('engine git ignores GIT_DIR and GIT_WORK_TREE in its own environment', async () => {
  const { dir } = await createRunDir(repo, 'run1', 'palimpsest/job1');
  const prev = { d: process.env.GIT_DIR, w: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(tempDir, 'nowhere');
  process.env.GIT_WORK_TREE = tempDir;
  try {
    const r = await engineGit(dir, ['rev-parse', '--show-toplevel']);
    assert.equal(realpathSync(r.stdout.trim()), realpathSync(dir));
  } finally {
    if (prev.d === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prev.d;
    if (prev.w === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = prev.w;
  }
});

test('engineGit does not run a planted hook', async () => {
  const { dir } = await createRunDir(repo, 'run1', 'palimpsest/job1');
  const marker = join(tempDir, 'hook-ran');
  for (const hook of ['pre-commit', 'commit-msg', 'post-commit', 'post-index-change', 'prepare-commit-msg']) {
    const p = join(dir, '.git', 'hooks', hook);
    writeFileSync(p, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(p, 0o755);
  }
  writeFileSync(join(dir, 'new.txt'), 'hello\n');
  const sha = await commitAll(dir, 'Add new', 'job1');
  assert.ok(sha);
  assert.ok(!existsSync(marker), 'a planted hook ran');
});

test("a nested repo's fsmonitor and hooks do not run under the engine's git", async () => {
  const { dir, baseSha } = await createRunDir(repo, 'run1', 'palimpsest/job1');
  const marker = join(tempDir, 'nested-ran');
  const nested = join(dir, 'sub');
  mkdirSync(nested);
  gitIn(nested, 'init', '-q');
  const script = join(tempDir, 'evil.sh');
  writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(script, 0o755);
  writeFileSync(join(nested, 'f'), 'f\n');
  gitIn(nested, 'add', 'f');
  gitIn(nested, 'commit', '-q', '-m', 'n');
  appendFileSync(join(nested, '.git', 'config'), `[core]\n\tfsmonitor = ${script}\n`);
  for (const hook of ['pre-commit', 'post-index-change']) {
    const p = join(nested, '.git', 'hooks', hook);
    writeFileSync(p, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(p, 0o755);
  }
  writeFileSync(join(nested, 'g'), 'dirty\n');
  await diffOf(dir, baseSha);
  await commitAll(dir, 'nested', 'job1');
  await engineGit(dir, ['status']);
  await engineGit(dir, ['diff', baseSha]);
  assert.ok(!existsSync(marker), 'nested repo code ran');
});

test('diffOf reports files, lines and a hash', async () => {
  const { dir, baseSha } = await createRunDir(repo, 'run1', 'palimpsest/job1');
  writeFileSync(join(dir, 'README.md'), 'one\nTWO\nthree\n');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  const d = await diffOf(dir, baseSha);
  assert.deepEqual(d.files.sort(), ['README.md', 'src/a.ts']);
  // README: -two +TWO +three (3); a.ts: +1.
  assert.equal(d.lines, 4);
  assert.match(d.patch, /\+TWO/);
  assert.equal(d.sha256, createHash('sha256').update(d.patch).digest('hex'));
});

test('commitAll returns null when clean and a sha after a write', async () => {
  const { dir } = await createRunDir(repo, 'run1', 'palimpsest/job1');
  assert.equal(await commitAll(dir, 'Nothing', 'job1'), null);
  writeFileSync(join(dir, 'b.txt'), 'b\n');
  const sha = await commitAll(dir, 'Add b', 'job1');
  assert.match(sha ?? '', /^[0-9a-f]{40}$/);
  assert.equal(gitIn(dir, 'rev-parse', 'HEAD'), sha);
  assert.equal(gitIn(dir, 'log', '-1', '--format=%an <%ae>|%cn <%ce>'), 'Palimpsest <palimpsest@local>|Palimpsest <palimpsest@local>');
  assert.match(gitIn(dir, 'log', '-1', '--format=%B'), /Palimpsest-Job: job1/);
  assert.equal(await commitAll(dir, 'Again', 'job1'), null);
});

test('removeRunDir keeps the log and the patch', async () => {
  const { runRoot } = await createRunDir(repo, 'run1', 'palimpsest/job1');
  writeFileSync(join(runRoot, 'log.jsonl'), '{}\n');
  writeFileSync(join(runRoot, 'diff.patch'), 'patch\n');
  mkdirSync(join(runRoot, 'inspection'));
  writeFileSync(join(runRoot, 'inspection', 'after.png'), 'png');
  removeRunDir('run1');
  assert.deepEqual(readdirSync(runRoot).sort(), ['diff.patch', 'inspection', 'log.jsonl']);
  assert.equal(readFileSync(join(runRoot, 'inspection', 'after.png'), 'utf8'), 'png');
  removeRunDir('missing-run');
});
