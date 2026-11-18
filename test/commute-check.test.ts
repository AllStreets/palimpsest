import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boardedTram, MAX_RETRIES, TRAM_WALKERS, type TripState } from '../tools/commute-check.js';

const walk: TripState = { stage: 'walk', ride: null };
const wait: TripState = { stage: 'wait', ride: null };
const ride = (mode: string): TripState => ({ stage: 'ride', ride: { mode, id: 'v1', phase: 'moving' } });

test('a walker who rode the tram within the clip boarded', () => {
  assert.equal(boardedTram([walk, wait, { stage: 'board', ride: null }, ride('tram')]), true);
});

test('a walker who only walked and waited never boarded', () => {
  assert.equal(boardedTram([walk, wait, wait, null]), false);
  assert.equal(boardedTram([]), false);
});

test('riding a cab is not boarding the tram', () => {
  assert.equal(boardedTram([walk, ride('cab')]), false);
});

test('there is a next walker for every retry', () => {
  assert.equal(MAX_RETRIES, 2);
  assert.ok(TRAM_WALKERS.length >= MAX_RETRIES + 1);
  assert.equal(new Set(TRAM_WALKERS).size, TRAM_WALKERS.length);
});
