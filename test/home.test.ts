import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { defaultHome, home, onRealDataHome, paths } from '../engine/home.js';

let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PALIMPSEST_HOME;
  else process.env.PALIMPSEST_HOME = previousHome;
});

test('the test runner marks this process, so the guard below is live', () => {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'node --test sets NODE_TEST_CONTEXT');
});

test('under NODE_TEST_CONTEXT with PALIMPSEST_HOME unset, home() throws', () => {
  delete process.env.PALIMPSEST_HOME;
  assert.throws(() => home(), /real data home/);
  assert.throws(() => paths(), /real data home/, 'paths() never creates folders in the real home');
});

test('under a test, an empty or real PALIMPSEST_HOME throws however it is spelled', () => {
  process.env.PALIMPSEST_HOME = '';
  assert.throws(() => home(), /real data home/);
  process.env.PALIMPSEST_HOME = defaultHome();
  assert.throws(() => home(), /real data home/);
  process.env.PALIMPSEST_HOME = join(defaultHome(), '..', 'Palimpsest');
  assert.throws(() => home(), /real data home/);
  process.env.PALIMPSEST_HOME = defaultHome().toUpperCase();
  assert.throws(() => home(), /real data home/);
});

test('outside a test, an unset or empty PALIMPSEST_HOME falls back to the default home', () => {
  assert.equal(home({}), join(homedir(), 'Library', 'Application Support', 'Palimpsest'));
  assert.equal(home({ PALIMPSEST_HOME: '' }), defaultHome());
});

test('onRealDataHome answers without throwing, so the real-home refusals still read', () => {
  delete process.env.PALIMPSEST_HOME;
  assert.equal(onRealDataHome(), true);
  process.env.PALIMPSEST_HOME = '/tmp/palimpsest-somewhere';
  assert.equal(onRealDataHome(), false);
});

test('a set PALIMPSEST_HOME is used as given', () => {
  process.env.PALIMPSEST_HOME = '/tmp/palimpsest-somewhere';
  assert.equal(home(), '/tmp/palimpsest-somewhere');
});
