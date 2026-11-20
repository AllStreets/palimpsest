import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isValidFullName } from '../engine/repos.js';

test('isValidFullName caps the owner at 39 characters', () => {
  assert.equal(isValidFullName(`${'a'.repeat(39)}/repo`), true);
  assert.equal(isValidFullName(`${'a'.repeat(40)}/repo`), false);
});

test('isValidFullName caps the repo name at 100 characters', () => {
  assert.equal(isValidFullName(`owner/${'b'.repeat(100)}`), true);
  assert.equal(isValidFullName(`owner/${'b'.repeat(101)}`), false);
});

test('isValidFullName still accepts and refuses the usual names', () => {
  assert.equal(isValidFullName('AllStreets/palimpsest'), true);
  assert.equal(isValidFullName('a/b.c_d-e'), true);
  assert.equal(isValidFullName('-a/b'), false);
  assert.equal(isValidFullName('a/..'), false);
  assert.equal(isValidFullName('a/b/c'), false);
});
