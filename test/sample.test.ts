import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { SAMPLE_MARKER } from '../engine/sample.js';
import { isRealDataHome } from '../tools/sample.js';

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
