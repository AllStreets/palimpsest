/**
 * No local dependencies at launch (Phase 5 ruling 22), on fixtures: the
 * real package.json fails today by design (the Beagle pin), so it is not
 * part of npm test until Task 33 moves the pin.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { installCheck } from '../tools/install-check.js';

test('installCheck names a git+file dependency in package.json and a file: resolved entry in the lock', () => {
  const pkg = {
    dependencies: { beagle: 'git+file:///Users/someone/beagle.git#76c2cbe', three: '^0.187.0' },
    devDependencies: { local: 'file:../local', vite: '^8.3.6' },
  };
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: pkg.dependencies },
      'node_modules/beagle': { version: '0.4.0', resolved: 'git+file:///Users/someone/beagle.git#76c2cbe' },
      'node_modules/kit': { version: '1.0.0', resolved: 'file:../kit' },
      'node_modules/three': { version: '0.187.0', resolved: 'https://registry.npmjs.org/three/-/three-0.187.0.tgz' },
      'node_modules/linked': { version: 'file:../linked' },
    },
  };
  const found = installCheck(pkg, lock);
  assert.ok(found.some((l) => /package\.json/.test(l) && /beagle/.test(l) && /git\+file:/.test(l)), found.join('\n'));
  assert.ok(found.some((l) => /package\.json/.test(l) && /local/.test(l) && /file:\.\.\/local/.test(l)), found.join('\n'));
  assert.ok(found.some((l) => /package-lock\.json/.test(l) && /node_modules\/beagle/.test(l)), found.join('\n'));
  assert.ok(found.some((l) => /package-lock\.json/.test(l) && /node_modules\/kit/.test(l) && /file:\.\.\/kit/.test(l)), found.join('\n'));
  assert.ok(found.some((l) => /package-lock\.json/.test(l) && /node_modules\/linked/.test(l)), 'a version that is a file: path is named too');
  assert.ok(!found.some((l) => /three|vite/.test(l)), 'registry dependencies are not named');
  assert.ok(!found.some((l) => /package-lock\.json.*""/.test(l) || / root /.test(l)), 'the root package entry is not a dependency');
});

test('installCheck finds nothing in a registry-only package and lock', () => {
  const pkg = { dependencies: { three: '^0.187.0' }, devDependencies: { vite: '^8.3.6' } };
  const lock = {
    lockfileVersion: 3,
    packages: {
      '': { dependencies: pkg.dependencies },
      'node_modules/three': { version: '0.187.0', resolved: 'https://registry.npmjs.org/three/-/three-0.187.0.tgz' },
    },
  };
  assert.deepEqual(installCheck(pkg, lock), []);
});

test('installCheck reads an old lock that nests dependencies', () => {
  const lock = { lockfileVersion: 1, dependencies: { a: { version: '1.0.0', dependencies: { b: { version: 'file:../b' } } } } };
  const found = installCheck({}, lock);
  assert.equal(found.length, 1);
  assert.ok(/a > b/.test(found[0]) && /file:\.\.\/b/.test(found[0]), found[0]);
});
