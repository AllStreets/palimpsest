import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
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
