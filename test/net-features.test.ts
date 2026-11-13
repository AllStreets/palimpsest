/**
 * The nets' feature lists and encoder (Phase 4 Task 8, ruling 8): pure, so
 * the engine, the trainer's rows and the screens read the same columns.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { encode, FEATURES } from '../shared/net-features.js';
import type { NetName } from '../shared/types.js';

const NETS: NetName[] = ['appraiser-pass', 'appraiser-cost', 'router', 'durability', 'triage', 'taste', 'master'];

test('encode one-hots a tier and masks nulls', () => {
  const cols = FEATURES['appraiser-pass'];
  const at = (name: string) => {
    const i = cols.indexOf(name);
    assert.ok(i >= 0, `no column ${name}`);
    return i;
  };
  const x = encode('appraiser-pass', { tier: 'normal', firm_pass_rate: null, confidence: 0.7 });
  assert.equal(x.length, cols.length);
  assert.deepEqual([x[at('tier=low')], x[at('tier=normal')], x[at('tier=high')]], [0, 1, 0]);
  assert.equal(x[at('firm_pass_rate')], 0);
  assert.equal(x[at('has_firm_pass_rate')], 0);
  assert.equal(x[at('confidence')], 0.7);

  const y = encode('appraiser-pass', { tier: 'high', firm_pass_rate: 0.5 });
  assert.deepEqual([y[at('tier=low')], y[at('tier=normal')], y[at('tier=high')]], [0, 0, 1]);
  assert.equal(y[at('firm_pass_rate')], 0.5);
  assert.equal(y[at('has_firm_pass_rate')], 1);

  // A tier it does not know, or none, is all zeros; every value is a finite number.
  const z = encode('appraiser-pass', { tier: 'urgent', confidence: Number.NaN });
  assert.deepEqual([z[at('tier=low')], z[at('tier=normal')], z[at('tier=high')]], [0, 0, 0]);
  assert.ok(z.every((v) => Number.isFinite(v)));
});

test('every net has its own fixed columns, and the router drops price, confidence and plan', () => {
  for (const net of NETS) {
    assert.ok(FEATURES[net].length > 0, net);
    assert.equal(new Set(FEATURES[net]).size, FEATURES[net].length, `${net} repeats a column`);
    assert.equal(encode(net, {}).length, FEATURES[net].length);
  }
  assert.deepEqual(FEATURES['appraiser-cost'], FEATURES['appraiser-pass']);
  for (const gone of ['price_over_value', 'confidence', 'plan_words']) {
    assert.ok(FEATURES['appraiser-pass'].includes(gone), gone);
    assert.ok(!FEATURES.router.includes(gone), gone);
  }
  assert.equal(FEATURES.master.filter((c) => c.startsWith('kind=')).length, 6);
});
