import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { defaultHome, home } from '../engine/home.js';

let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.PALIMPSEST_HOME;
  else process.env.PALIMPSEST_HOME = previousHome;
});

test('an empty PALIMPSEST_HOME falls back to the default home', () => {
  process.env.PALIMPSEST_HOME = '';
  assert.equal(home(), join(homedir(), 'Library', 'Application Support', 'Palimpsest'));
  assert.equal(home(), defaultHome());
});

test('a set PALIMPSEST_HOME is used as given', () => {
  process.env.PALIMPSEST_HOME = '/tmp/palimpsest-somewhere';
  assert.equal(home(), '/tmp/palimpsest-somewhere');
});
