/**
 * The launch gate (Phase 5 Task 33): the repo's own package.json and lock
 * carry no local dependency, so a stranger's clone installs from the
 * registries and GitHub alone.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { installCheck } from '../tools/install-check.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string): object => JSON.parse(readFileSync(join(root, f), 'utf8')) as object;

test('the repo package.json and package-lock.json have no local dependencies', () => {
  assert.deepEqual(installCheck(read('package.json'), read('package-lock.json')), []);
});
