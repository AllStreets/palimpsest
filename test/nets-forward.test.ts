/**
 * The nets' forward pass in TypeScript (Phase 4 Task 11, ruling 8): the
 * engine runs every trained net itself, with no Python, so its weights file
 * is checked before use and its arithmetic matches MLX's `nn.gelu` net.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { FEATURES } from '../shared/net-features.js';
import { erf, forward, parseNet, type NetWeights } from '../shared/nets.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/net-parity.json', import.meta.url), 'utf8')) as { weights: unknown; x: number[][]; y: number[] };

/** A well-formed taste net: 9 columns, 2 hidden units. */
function valid(): Record<string, unknown> {
  const d = FEATURES.taste.length;
  return {
    net: 'taste',
    version: 1,
    features: [...FEATURES.taste],
    norm: { mean: Array(d).fill(0), std: Array(d).fill(1) },
    layers: [
      { W: [Array(d).fill(0.1), Array(d).fill(-0.1)], b: [0, 0] },
      { W: [[1, 1]], b: [0] },
    ],
    out: 'sigmoid',
  };
}

test('parseNet accepts a well-formed net', () => {
  const net = parseNet(JSON.stringify(valid()));
  assert.ok(net);
  assert.equal(net.net, 'taste');
  assert.equal(net.layers[0]!.W.length, 2);
});

test('parseNet refuses NaN, a missing layer and a size mismatch', () => {
  // NaN cannot be written in JSON, so it arrives as a string or as a bare token
  const nan = valid();
  (nan.norm as { mean: unknown[] }).mean[0] = 'NaN';
  assert.equal(parseNet(JSON.stringify(nan)), null);
  assert.equal(parseNet(JSON.stringify(valid()).replace('"std":[1', '"std":[NaN')), null);
  const huge = JSON.stringify(valid()).replace('"b":[0,0]', '"b":[1e400,0]');
  assert.equal(parseNet(huge), null);

  const missing = valid();
  (missing.layers as unknown[]).pop();
  assert.equal(parseNet(JSON.stringify(missing)), null);

  const short = valid();
  ((short.layers as Array<{ W: number[][] }>)[0]!.W[1] as number[]).pop();
  assert.equal(parseNet(JSON.stringify(short)), null);
  const headWide = valid();
  (headWide.layers as Array<{ W: number[][] }>)[1]!.W[0]!.push(1);
  assert.equal(parseNet(JSON.stringify(headWide)), null);
  const meanShort = valid();
  (meanShort.norm as { mean: number[] }).mean.pop();
  assert.equal(parseNet(JSON.stringify(meanShort)), null);

  // the columns are the net's own, in order, so weights trained on old columns are never run
  const renamed = valid();
  (renamed.features as string[]).reverse();
  assert.equal(parseNet(JSON.stringify(renamed)), null);
  const zeroStd = valid();
  (zeroStd.norm as { std: number[] }).std[0] = 0;
  assert.equal(parseNet(JSON.stringify(zeroStd)), null);
  assert.equal(parseNet(JSON.stringify({ ...valid(), out: 'linear' })), null, 'only the cost head is linear');
  assert.equal(parseNet(JSON.stringify({ ...valid(), net: 'oracle' })), null);
  assert.equal(parseNet(JSON.stringify({ ...valid(), version: 0 })), null);
  assert.equal(parseNet('not json'), null);
  assert.equal(parseNet('[]'), null);
});

test('erf matches tabulated values to 1e-9', () => {
  const table: Array<[number, number]> = [
    [0, 0],
    [0.1, 0.1124629160182849],
    [0.5, 0.5204998778130465],
    [1, 0.8427007929497148],
    [1.5, 0.9661051464753108],
    [2, 0.9953222650189527],
    [2.5, 0.999593047982555],
    [3, 0.9999779095030015],
    [3.5, 0.9999992569016276],
    [4, 0.9999999845827421],
    [5, 0.9999999999984626],
    [-0.3, -0.32862675945912734],
    [-1.2, -0.9103139782296354],
    [-2.7, -0.9998656672600594],
  ];
  for (const [x, want] of table) assert.ok(Math.abs(erf(x) - want) < 1e-9, `erf(${x}) = ${erf(x)}, want ${want}`);
  assert.equal(erf(40), 1);
  assert.equal(erf(-40), -1);
  assert.equal(erf(Infinity), 1);
});

test('forward matches a hand-computed two-unit net', () => {
  // z = (3 - 1) / 2 = 1; h = gelu([1, -0.5]); o = 2 h0 + h1 - 1; out = sigmoid(o)
  const net: NetWeights = {
    net: 'taste',
    version: 1,
    features: ['a'],
    norm: { mean: [1], std: [2] },
    layers: [
      { W: [[1], [-1]], b: [0, 0.5] },
      { W: [[2, 1]], b: [-1] },
    ],
    out: 'sigmoid',
  };
  // gelu(1) = 0.8413447460685429, gelu(-0.5) = -0.15426876936299347, o = 0.5284207227740925
  assert.ok(Math.abs(forward(net, [3]) - 0.6291146953666685) < 1e-12);
  assert.ok(Math.abs(forward({ ...net, out: 'linear' }, [3]) - 0.5284207227740925) < 1e-12);
});

test("forward matches net-parity.json's 20 expected outputs to 1e-5", () => {
  const net = parseNet(JSON.stringify(fixture.weights));
  assert.ok(net, 'the fixture is a well-formed net');
  assert.equal(fixture.x.length, 20);
  assert.equal(fixture.y.length, 20);
  fixture.x.forEach((x, i) => {
    const got = forward(net, x);
    assert.ok(Math.abs(got - fixture.y[i]!) < 1e-5, `row ${i}: ${got} vs ${fixture.y[i]}`);
  });
  // the fixture is not a flat net: its outputs spread
  assert.ok(Math.max(...fixture.y) - Math.min(...fixture.y) > 0.5);
});

test('forward refuses a row of the wrong length', () => {
  const net = parseNet(JSON.stringify(valid()))!;
  assert.throws(() => forward(net, [1, 2]), /taste takes 8 features, not 2/);
});
