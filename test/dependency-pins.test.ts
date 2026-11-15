/**
 * Every dependency installs from a registry or a public host, never from a
 * path on one machine: no `file:`, `git+file:` or `link:` spec in
 * package.json, and no such `resolved` or `version` in package-lock.json, so
 * a fresh clone anywhere runs `npm ci`. Beagle is pinned to GitHub by full sha.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = join(import.meta.dirname, '..');
const LOCAL = /^(git\+)?file:|^link:/i;

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

test('beagle is pinned to GitHub by full sha', () => {
  const spec = (pkg.dependencies as Record<string, string>).beagle;
  assert.match(spec, /^github:AllStreets\/beagle#[0-9a-f]{40}$/);
  const sha = spec.split('#')[1];
  const resolved = String(lock.packages?.['node_modules/beagle']?.resolved ?? '');
  assert.match(resolved, /github\.com\/AllStreets\/beagle\.git#[0-9a-f]{40}$/);
  assert.ok(resolved.endsWith(`#${sha}`), 'the lockfile resolves beagle to the same sha');
});
