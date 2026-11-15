/**
 * Every dependency installs from a registry or a public host, never from a
 * path on one machine: no `file:`, `git+file:` or `link:` spec in
 * package.json, and no such `resolved` or `version` in package-lock.json, so
 * a fresh clone anywhere runs `npm ci`. Beagle is pinned to GitHub by full
 * sha and fetched as an HTTPS tarball from codeload.github.com, never over
 * SSH, so a clone without GitHub SSH access, and a run's sandboxed install,
 * can fetch it.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');
const LOCAL = /^(git\+)?file:|^link:/i;
/** SSH or the bare git protocol: a clone without GitHub SSH access cannot fetch it, and a run's install never may. */
const SSH = /^(git\+)?ssh:|^git:\/\/|^[\w.-]+@[\w.-]+:/i;
const BEAGLE = /^https:\/\/codeload\.github\.com\/AllStreets\/beagle\/tar\.gz\/([0-9a-f]{40})$/;

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
  packages?: Record<string, Record<string, unknown>>;
};

const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides'];

test('no dependency in package.json is a local path', () => {
  for (const section of SECTIONS) {
    const deps = (pkg[section] ?? {}) as Record<string, unknown>;
    for (const [name, spec] of Object.entries(deps)) {
      assert.ok(typeof spec !== 'string' || !LOCAL.test(spec.trim()), `${section}.${name} resolves to a local path: ${String(spec)}`);
    }
  }
});

test('no package in package-lock.json resolves to a local path', () => {
  const packages = lock.packages ?? {};
  assert.ok(Object.keys(packages).length > 1, 'the lockfile lists its packages');
  for (const [path, entry] of Object.entries(packages)) {
    for (const key of ['resolved', 'version']) {
      const v = entry[key];
      assert.ok(typeof v !== 'string' || !LOCAL.test(v.trim()), `${path || '(root)'} ${key} is a local path: ${String(v)}`);
    }
    assert.ok(entry.link !== true, `${path} is a link to a local folder`);
    for (const section of SECTIONS) {
      const deps = (entry[section] ?? {}) as Record<string, unknown>;
      for (const [name, spec] of Object.entries(deps)) {
        assert.ok(typeof spec !== 'string' || !LOCAL.test(spec.trim()), `${path || '(root)'} ${section}.${name} is a local path: ${String(spec)}`);
      }
    }
  }
});

test('beagle is pinned to GitHub by full sha, as an HTTPS tarball', () => {
  const spec = (pkg.dependencies as Record<string, string>).beagle;
  const m = BEAGLE.exec(spec);
  assert.ok(m, `beagle is not an https codeload tarball at a full sha: ${spec}`);
  const sha = m[1];
  const entry = lock.packages?.['node_modules/beagle'] ?? {};
  const resolved = String(entry.resolved ?? '');
  assert.match(resolved, BEAGLE, `the lockfile resolves beagle to ${resolved}`);
  assert.ok(resolved.endsWith(`/${sha}`), 'the lockfile resolves beagle to the same sha');
  assert.match(String(entry.integrity ?? ''), /^sha512-/, 'the lockfile carries an integrity hash for beagle');
});

test('no dependency resolves over SSH or the git protocol', () => {
  for (const section of SECTIONS) {
    for (const [name, spec] of Object.entries((pkg[section] ?? {}) as Record<string, unknown>)) {
      assert.ok(typeof spec !== 'string' || !SSH.test(spec.trim()), `${section}.${name} resolves over SSH: ${String(spec)}`);
      // A bare `github:` or `owner/repo` spec is npm's shorthand that it writes to the lockfile as git+ssh.
      assert.ok(typeof spec !== 'string' || !/^(github:|[\w.-]+\/[\w.-]+(#|$))/.test(spec.trim()), `${section}.${name} is a GitHub shorthand npm resolves over SSH: ${String(spec)}`);
    }
  }
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const v = entry.resolved;
    assert.ok(typeof v !== 'string' || !SSH.test(v.trim()), `${path || '(root)'} resolves over SSH: ${String(v)}`);
  }
});
