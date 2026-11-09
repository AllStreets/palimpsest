import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { realRunner, setRunner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { parseLog, readLog, syncMirror } from '../engine/mirror.js';

let tempDir: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-mirror-test-'));
  process.env.PALIMPSEST_HOME = tempDir;
});

afterEach(() => {
  setRunner(realRunner);
  if (previousHome === undefined) {
    delete process.env.PALIMPSEST_HOME;
  } else {
    process.env.PALIMPSEST_HOME = previousHome;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

test('parseLog parses numstat and trailers', () => {
  const sha1 = 'd1121215f82977324e6e496d9507e9eb15f78772a';
  const at1 = '2026-11-08T20:43:02-06:00';
  const sha2 = '73d1689115d9d5875e199bace4d6f865ed927455';
  const at2 = '2026-11-08T20:43:05-06:00';
  const coAuthor = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';

  const raw =
    `\x1e${sha1}\x1f${at1}\x1fAuthor One\x1ffirst commit\x1f\x1f` +
    `\n\n1\t0\tfile1.txt\n` +
    `\x1e${sha2}\x1f${at2}\x1fAuthor One\x1fsecond commit\x1fbody line one\n\n${coAuthor}\n\x1f` +
    `\n\n1\t0\tfile1.txt\n-\t-\timg.png\n`;

  const commits = parseLog(raw);

  assert.equal(commits.length, 2);
  assert.deepEqual(commits[0], {
    sha: sha1,
    at: at1,
    author: 'Author One',
    subject: 'first commit',
    body: '',
    lines: 1,
  });
  assert.deepEqual(commits[1], {
    sha: sha2,
    at: at2,
    author: 'Author One',
    subject: 'second commit',
    body: `body line one\n\n${coAuthor}`,
    lines: 1,
  });
  assert.ok(commits[1].body.includes(coAuthor));
});

test('readLog returns [] for an empty repo', async () => {
  const dir = join(tempDir, 'empty.git');
  const init = await realRunner('git', ['init', '--quiet', '--bare', dir]);
  assert.equal(init.code, 0);

  const commits = await readLog(dir, 'HEAD');

  assert.deepEqual(commits, []);
});

test('readLog returns [] for an empty repo via a literal branch name', async () => {
  // No commits means no refs/heads/<branch> exists at all, so git reports
  // "unknown revision" for a literal branch name (unlike HEAD, which git
  // special-cases with "does not have any commits"). Both must mean empty.
  const dir = join(tempDir, 'empty-literal.git');
  const init = await realRunner('git', ['init', '--quiet', '--bare', dir]);
  assert.equal(init.code, 0);

  const commits = await readLog(dir, 'main');

  assert.deepEqual(commits, []);
});

test('readLog rejects naming the branch when it is wrong on a non-empty repo', async () => {
  const srcDir = join(tempDir, 'src');
  const mirrorDir = join(tempDir, 'nonempty.git');

  await realRunner('git', ['init', '--quiet', srcDir]);
  await realRunner('git', ['-C', srcDir, 'config', 'user.email', 'a@b.com']);
  await realRunner('git', ['-C', srcDir, 'config', 'user.name', 'A']);
  const write = await realRunner('sh', ['-c', `echo hi > "${join(srcDir, 'f.txt')}"`]);
  assert.equal(write.code, 0);
  await realRunner('git', ['-C', srcDir, 'add', 'f.txt']);
  await realRunner('git', ['-C', srcDir, 'commit', '--quiet', '-m', 'one']);
  const clone = await realRunner('git', ['clone', '--quiet', '--bare', srcDir, mirrorDir]);
  assert.equal(clone.code, 0);

  await assert.rejects(readLog(mirrorDir, 'no-such-branch'), (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /no-such-branch/);
    return true;
  });
});

test('syncMirror clones with gh when the mirror does not exist', async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  setRunner(async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: '', stderr: '', code: 0 };
  });

  const dir = await syncMirror('AllStreets/palimpsest');

  assert.equal(dir, join(paths().mirrors, 'AllStreets__palimpsest.git'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'gh');
  assert.deepEqual(calls[0].args, ['repo', 'clone', 'AllStreets/palimpsest', dir, '--', '--bare']);
});

test('syncMirror fetches with git when the mirror already exists', async () => {
  const dir = join(paths().mirrors, 'AllStreets__palimpsest.git');
  mkdirSync(dir, { recursive: true });

  const calls: Array<{ cmd: string; args: string[] }> = [];
  setRunner(async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: '', stderr: '', code: 0 };
  });

  const result = await syncMirror('AllStreets/palimpsest');

  assert.equal(result, dir);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'git');
  assert.deepEqual(calls[0].args, ['-C', dir, 'fetch', 'origin', '+refs/heads/*:refs/heads/*', '--prune']);
});
