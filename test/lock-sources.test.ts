/**
 * The GitHub sources a repo's lockfiles name: the install stage allows
 * exactly the HTTPS hosts they need and refuses SSH plainly. Pure reads of
 * temp lockfiles; nothing is installed and no host is reached.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { lockSources } from '../engine/market/lock-sources.js';

const SHA = 'd72c872ec704565da88e8cf792af1b06a23fd285';
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'palimpsest-lock-sources-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function npmLock(packages: Record<string, Record<string, unknown>>): void {
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' }, ...packages } }));
}

test('no lockfile, or registry-only dependencies, need no extra host', () => {
  assert.deepEqual(lockSources(dir), { hosts: [], refused: [] });
  npmLock({ 'node_modules/three': { version: '0.187.0', resolved: 'https://registry.npmjs.org/three/-/three-0.187.0.tgz' } });
  assert.deepEqual(lockSources(dir), { hosts: [], refused: [] });
});

test('a codeload tarball adds codeload.github.com only', () => {
  npmLock({ 'node_modules/beagle': { version: '0.1.0', resolved: `https://codeload.github.com/AllStreets/beagle/tar.gz/${SHA}` } });
  assert.deepEqual(lockSources(dir), { hosts: ['codeload.github.com'], refused: [] });
});

test('a git+https dependency adds github.com; a github.com archive adds both', () => {
  npmLock({
    'node_modules/a': { version: '1.0.0', resolved: `git+https://github.com/acme/a.git#${SHA}` },
    'node_modules/b': { version: '1.0.0', resolved: `https://github.com/acme/b/archive/${SHA}.tar.gz` },
  });
  assert.deepEqual(lockSources(dir), { hosts: ['github.com', 'codeload.github.com'], refused: [] });
});

test('a git+ssh dependency is refused by name, and opens no host', () => {
  npmLock({ 'node_modules/beagle': { version: '0.1.0', resolved: `git+ssh://git@github.com/AllStreets/beagle.git#${SHA}` } });
  const r = lockSources(dir);
  assert.deepEqual(r.hosts, []);
  assert.equal(r.refused.length, 1);
  assert.equal(r.refused[0].name, 'beagle');
  assert.equal(r.refused[0].file, 'package-lock.json');
  assert.equal(r.refused[0].url, `git+ssh://git@github.com/AllStreets/beagle.git#${SHA}`);
  assert.match(r.refused[0].reason, /SSH/);
});

test('scp-style and git:// sources are refused too', () => {
  npmLock({
    'node_modules/a': { version: '1.0.0', resolved: `git@github.com:acme/a.git#${SHA}` },
    'node_modules/b': { version: '1.0.0', resolved: `git://github.com/acme/b.git#${SHA}` },
  });
  assert.deepEqual(lockSources(dir).refused.map((r) => r.name), ['a', 'b']);
});

test('another https host is never added', () => {
  npmLock({ 'node_modules/a': { version: '1.0.0', resolved: 'https://gitlab.com/acme/a/-/archive/v1/a-v1.tar.gz' } });
  assert.deepEqual(lockSources(dir), { hosts: [], refused: [] });
});

test('a nested package keeps its own name', () => {
  npmLock({ 'node_modules/x/node_modules/@acme/y': { version: '1.0.0', resolved: `git+ssh://git@github.com/acme/y.git#${SHA}` } });
  assert.equal(lockSources(dir).refused[0].name, '@acme/y');
});

test('yarn, pnpm, Cargo and pip lockfiles are read the same way', () => {
  writeFileSync(
    join(dir, 'yarn.lock'),
    `"beagle@https://codeload.github.com/AllStreets/beagle/tar.gz/${SHA}":\n  version "0.1.0"\n  resolved "https://codeload.github.com/AllStreets/beagle/tar.gz/${SHA}"\n\nleft-pad@^1.0.0:\n  version "1.3.0"\n  resolved "https://registry.yarnpkg.com/left-pad/-/left-pad-1.3.0.tgz"\n`,
  );
  writeFileSync(
    join(dir, 'pnpm-lock.yaml'),
    `lockfileVersion: '9.0'\npackages:\n  widget@https://codeload.github.com/acme/widget/tar.gz/${SHA}:\n    resolution: {tarball: https://codeload.github.com/acme/widget/tar.gz/${SHA}}\n    version: 1.0.0\n  gadget@git+ssh://git@github.com/acme/gadget.git#${SHA}:\n    resolution: {commit: ${SHA}, repo: git+ssh://git@github.com/acme/gadget.git, type: git}\n    version: 1.0.0\n`,
  );
  writeFileSync(
    join(dir, 'Cargo.lock'),
    `[[package]]\nname = "serde"\nversion = "1.0.0"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\n\n[[package]]\nname = "wasmish"\nversion = "0.1.0"\nsource = "git+https://github.com/acme/wasmish?rev=${SHA}#${SHA}"\n\n[[package]]\nname = "secret"\nversion = "0.1.0"\nsource = "git+ssh://git@github.com/acme/secret#${SHA}"\n`,
  );
  writeFileSync(join(dir, 'requirements.txt'), `requests==2.32.0\ntoolkit @ git+https://github.com/acme/toolkit@${SHA}\n-e git+ssh://git@github.com/acme/private.git@${SHA}#egg=private\n`);
  const r = lockSources(dir);
  assert.deepEqual(r.hosts.sort(), ['codeload.github.com', 'github.com']);
  assert.deepEqual(
    r.refused.map((x) => `${x.file}: ${x.name}`),
    ['pnpm-lock.yaml: gadget', 'Cargo.lock: secret', 'requirements.txt: private'],
  );
});

test('a lockfile that is not valid text is skipped, not thrown', () => {
  writeFileSync(join(dir, 'package-lock.json'), '{ not json');
  assert.deepEqual(lockSources(dir), { hosts: [], refused: [] });
});
