import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { SAMPLE_MARKER } from '../engine/sample.js';
import { isRealDataHome } from '../engine/home.js';

let tempDir: string;
let fakeUserHome: string;
let realHome: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-sample-test-'));
  fakeUserHome = join(tempDir, 'user');
  realHome = join(fakeUserHome, 'Library', 'Application Support', 'Palimpsest');
  mkdirSync(realHome, { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Runs tools/sample.ts with the user's home pointed at the temp folder, so the real data home is never in reach. */
function runSample(dir: string): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, ['--no-warnings', '--import', 'tsx', 'tools/sample.ts', dir], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fakeUserHome, PALIMPSEST_HOME: '' },
  });
  return { status: r.status, stderr: r.stderr };
}

test('the real data home is recognised through a symlink and in any letter case', () => {
  const link = join(tempDir, 'link');
  symlinkSync(realHome, link);
  assert.equal(isRealDataHome(realHome, realHome), true);
  assert.equal(isRealDataHome(link, realHome), true, 'a symlink to it');
  assert.equal(isRealDataHome(realHome.toUpperCase(), realHome), true, 'another letter case');
  assert.equal(isRealDataHome(join(realHome, '..', 'Palimpsest'), realHome), true, 'a path with a parent step');
  assert.equal(isRealDataHome(join(tempDir, 'elsewhere'), realHome), false);
  assert.equal(isRealDataHome(join(realHome, 'inner'), realHome), false);
});

test('the sample tool refuses the real data home however it is named', () => {
  const link = join(tempDir, 'link');
  symlinkSync(realHome, link);
  for (const dir of [link, realHome.replace('Palimpsest', 'palimpsest')]) {
    const r = runSample(dir);
    assert.equal(r.status, 2, dir);
    assert.match(r.stderr, /refusing/);
    assert.equal(existsSync(join(realHome, SAMPLE_MARKER)), false);
    assert.equal(existsSync(join(realHome, 'palimpsest.db')), false);
  }
});

test('the sample tool marks the home it writes as a sample home', () => {
  const dir = join(tempDir, 'sample');
  const r = runSample(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(join(dir, SAMPLE_MARKER)), true);
  assert.equal(existsSync(join(dir, 'palimpsest.db')), true);
});

test('the sample stand-in keeps an API key in memory: security never runs, and no keychain is touched', async () => {
  const { sampleGh, sampleSpawner, sampleKeychain } = await import('../engine/sample.js');
  const { getRunner, getSpawner, setRunner, setSpawner } = await import('../engine/exec.js');
  const { apiKey, apiKeyStored, removeApiKey, setApiKey } = await import('../engine/market/anthropic-api.js');
  const { writeFileSync } = await import('node:fs');
  process.env.PALIMPSEST_HOME = join(tempDir, 'home');
  const kc = join(tempDir, 'stand-in.keychain-db');
  writeFileSync(kc, '');
  const KEY = 'sk-ant-api03-SAMPLEKEYONLY0000';
  const [runner, spawner] = [getRunner(), getSpawner()];
  setRunner(sampleGh());
  setSpawner(sampleSpawner);
  try {
    sampleKeychain.reset();
    assert.equal(await apiKey({ keychain: kc }), null);
    await setApiKey(KEY, { keychain: kc });
    assert.equal(await apiKey({ keychain: kc }), KEY, 'held by the stand-in');
    assert.equal(sampleKeychain.isSet(), true);
    assert.equal(await apiKeyStored({ keychain: kc }), true, 'the item is found without reading its secret');
    const bare = sampleKeychain.answer('/usr/bin/security', ['find-generic-password', '-s', 'Palimpsest Anthropic API key', kc]);
    assert.equal(bare?.code, 0);
    assert.ok(!bare?.stdout.includes(KEY), 'the no -w form never prints the key');
    await removeApiKey({ keychain: kc });
    assert.equal(await apiKey({ keychain: kc }), null, 'and gone once removed');
    assert.equal(await apiKeyStored({ keychain: kc }), false);
    // Anything but security still starts nothing in a sample engine.
    const other = await sampleSpawner('claude', ['-p'], {}).done;
    assert.match(other.error ?? '', /not started in a sample engine/);
  } finally {
    setRunner(runner);
    setSpawner(spawner);
    sampleKeychain.reset();
    delete process.env.PALIMPSEST_HOME;
  }
});

test('a sample engine never keeps a folder override that names his own Claude, Codex or Gemini folders, however a symlink spells it; a test temp folder is kept', async () => {
  const { homedir } = await import('node:os');
  const { useSampleFolders, sampleProjectsDir, sampleCodexHome, sampleGeminiHome } = await import('../engine/sample.js');
  const KEYS = ['PALIMPSEST_CLAUDE_PROJECTS', 'PALIMPSEST_CODEX_HOME', 'PALIMPSEST_GEMINI_HOME'] as const;
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  const dir = join(tempDir, 'sample-home');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SAMPLE_MARKER), '{}\n');
  try {
    // Only named, never opened: the comparison is on the path's text.
    process.env.PALIMPSEST_CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');
    process.env.PALIMPSEST_CODEX_HOME = join(homedir(), '.CODEX');
    process.env.PALIMPSEST_GEMINI_HOME = `${join(homedir(), '.gemini')}/`;
    useSampleFolders(dir);
    assert.equal(process.env.PALIMPSEST_CLAUDE_PROJECTS, sampleProjectsDir(dir));
    assert.equal(process.env.PALIMPSEST_CODEX_HOME, sampleCodexHome(dir));
    assert.equal(process.env.PALIMPSEST_GEMINI_HOME, sampleGeminiHome(dir));

    // A symlink spelled differently that leads to his home is resolved first: its real path names his folders.
    const alias = join(tempDir, 'alias-of-his-home');
    symlinkSync(homedir(), alias);
    process.env.PALIMPSEST_CLAUDE_PROJECTS = join(alias, '.claude', 'projects');
    process.env.PALIMPSEST_CODEX_HOME = join(alias, '.codex');
    const gemini = join(tempDir, 'gemini-alias');
    symlinkSync(join(homedir(), '.gemini'), gemini);
    process.env.PALIMPSEST_GEMINI_HOME = join(gemini, 'tmp');
    useSampleFolders(dir);
    assert.equal(process.env.PALIMPSEST_CLAUDE_PROJECTS, sampleProjectsDir(dir), 'a symlink to his home is resolved');
    assert.equal(process.env.PALIMPSEST_CODEX_HOME, sampleCodexHome(dir));
    assert.equal(process.env.PALIMPSEST_GEMINI_HOME, sampleGeminiHome(dir), 'a symlink to his folder itself is resolved');

    const mine = join(tempDir, 'projects');
    process.env.PALIMPSEST_CLAUDE_PROJECTS = mine;
    useSampleFolders(dir);
    assert.equal(process.env.PALIMPSEST_CLAUDE_PROJECTS, mine, 'a temp folder override is kept');
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});

// ---------------------------------------------------------------- Phase 5 Task 20: one command, and only on a sample

test('seedSample marks the home before it writes anything, so seedEconomy and seedSchool accept it', async () => {
  const { seedSample } = await import('../tools/sample.js');
  const { isSampleHome } = await import('../engine/sample.js');
  const saved = process.env.PALIMPSEST_HOME;
  try {
    // Where the marker cannot be written, nothing else is: the marker comes first.
    const blocked = join(tempDir, 'blocked');
    mkdirSync(join(blocked, SAMPLE_MARKER), { recursive: true });
    process.env.PALIMPSEST_HOME = blocked;
    await assert.rejects(seedSample(Date.parse('2026-11-10T17:30:00Z')));
    assert.deepEqual(readdirSync(blocked), [SAMPLE_MARKER], 'no database, no reading, nothing but the blocked marker');

    const dir = join(tempDir, 'marked');
    process.env.PALIMPSEST_HOME = dir;
    await seedSample(Date.parse('2026-11-10T17:30:00Z'));
    assert.equal(isSampleHome(dir), true);
    assert.equal(existsSync(join(dir, 'palimpsest.db')), true);
  } finally {
    if (saved === undefined) delete process.env.PALIMPSEST_HOME;
    else process.env.PALIMPSEST_HOME = saved;
  }
});

test('the sample folders are set only on a sample home', async () => {
  const { useSampleFolders } = await import('../engine/sample.js');
  const plain = join(tempDir, 'plain');
  mkdirSync(plain, { recursive: true });
  const saved = process.env.PALIMPSEST_CLAUDE_PROJECTS;
  try {
    process.env.PALIMPSEST_CLAUDE_PROJECTS = join(tempDir, 'mine');
    assert.throws(() => useSampleFolders(plain), /Not a sample home/);
    assert.equal(process.env.PALIMPSEST_CLAUDE_PROJECTS, join(tempDir, 'mine'), 'nothing changed');
  } finally {
    if (saved === undefined) delete process.env.PALIMPSEST_CLAUDE_PROJECTS;
    else process.env.PALIMPSEST_CLAUDE_PROJECTS = saved;
  }
});

/** The env sampleTarget reads, with his home pointed at the temp folder so the real data home is only ever named. */
function targetEnv(target?: string): NodeJS.ProcessEnv {
  return { HOME: fakeUserHome, ...(target === undefined ? {} : { PALIMPSEST_SAMPLE_HOME: target }) };
}

test('sampleTarget refuses the real home', async () => {
  const { sampleTarget } = await import('../tools/sample-run.js');
  const link = join(tempDir, 'link');
  symlinkSync(realHome, link);
  for (const dir of [realHome, link, realHome.toLowerCase().replace(fakeUserHome.toLowerCase(), fakeUserHome), join(realHome, 'inner')]) {
    assert.deepEqual(sampleTarget(targetEnv(dir), tempDir), { refuse: 'That is your real Palimpsest folder; the sample needs its own.' }, dir);
  }
  // Relative to the folder it is run from, too.
  assert.deepEqual(sampleTarget(targetEnv('Palimpsest'), join(fakeUserHome, 'Library', 'Application Support')), { refuse: 'That is your real Palimpsest folder; the sample needs its own.' });
  assert.deepEqual(readdirSync(realHome), [], 'nothing written there');
});

test('it refuses a non-empty folder without the marker', async () => {
  const { sampleTarget } = await import('../tools/sample-run.js');
  const docs = join(fakeUserHome, 'Documents');
  mkdirSync(docs, { recursive: true });
  writeFileSync(join(docs, 'letter.txt'), 'dear');
  const refuse = { refuse: 'That folder has files in it and is not a sample; choose an empty one.' };
  assert.deepEqual(sampleTarget(targetEnv(docs), tempDir), refuse);
  // A file where the folder should be is refused the same way.
  assert.deepEqual(sampleTarget(targetEnv(join(docs, 'letter.txt')), tempDir), refuse);
  // The default, <repo>/sample-home, is held to the same rule.
  mkdirSync(join(tempDir, 'repo', 'sample-home'), { recursive: true });
  writeFileSync(join(tempDir, 'repo', 'sample-home', 'notes.md'), 'mine');
  assert.deepEqual(sampleTarget(targetEnv(), join(tempDir, 'repo')), refuse);
  assert.deepEqual(readdirSync(docs), ['letter.txt']);
});

test('it reuses a folder with the marker', async () => {
  const { sampleTarget } = await import('../tools/sample-run.js');
  const used = join(tempDir, 'used');
  mkdirSync(used, { recursive: true });
  writeFileSync(join(used, SAMPLE_MARKER), '{}\n');
  writeFileSync(join(used, 'palimpsest.db'), '');
  assert.deepEqual(sampleTarget(targetEnv(used), tempDir), { dir: used });
  // An empty folder, a folder not there yet, and the default under the repo are all fine.
  const empty = join(tempDir, 'empty');
  mkdirSync(empty);
  assert.deepEqual(sampleTarget(targetEnv(empty), tempDir), { dir: empty });
  assert.deepEqual(sampleTarget(targetEnv('later'), tempDir), { dir: join(tempDir, 'later') });
  assert.deepEqual(sampleTarget(targetEnv(), join(tempDir, 'repo')), { dir: join(tempDir, 'repo', 'sample-home') });
  assert.deepEqual(sampleTarget({ ...targetEnv(), PALIMPSEST_SAMPLE_HOME: '' }, join(tempDir, 'repo')), { dir: join(tempDir, 'repo', 'sample-home') });
});
