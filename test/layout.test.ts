import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DISTRICT_PITCH, districtOrigin } from '../engine/layout.js';
import { FLOOR_HEIGHT, layoutTower, ROOT_HEIGHT } from '../shared/tower-layout.js';
import type { Floor, TowerSpec } from '../shared/types.js';

function floor(overrides: Partial<Floor> & { id: string; size: Floor['size'] }): Floor {
  return {
    repo: 'acme/widgets',
    kind: 'commits',
    refs: ['abc1234'],
    title: 'a change',
    at: '2026-01-01T00:00:00.000Z',
    era: 'stone',
    lines: 10,
    claude: false,
    founding: true,
    url: null,
    ...overrides,
  };
}

test('districtOrigin: first nine are distinct and none is the civic plaza', () => {
  const origins = Array.from({ length: 9 }, (_, i) => districtOrigin(i));

  for (const o of origins) {
    assert.notDeepEqual(o, { x: 0, z: 0 });
  }

  const keys = origins.map((o) => `${o.x},${o.z}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('districtOrigin: a given index is identical across calls', () => {
  const first = districtOrigin(3);
  const second = districtOrigin(3);
  assert.deepEqual(first, second);
});

test('districtOrigin: origins are multiples of DISTRICT_PITCH', () => {
  for (let i = 0; i < 9; i++) {
    const { x, z } = districtOrigin(i);
    assert.ok(Number.isInteger(x / DISTRICT_PITCH));
    assert.ok(Number.isInteger(z / DISTRICT_PITCH));
  }
});

test('layoutTower: an empty tower is root-only', () => {
  const spec: TowerSpec = {
    id: 'acme/widgets#founding',
    repo: 'acme/widgets',
    kind: 'founding',
    root: 'roman',
    floors: [],
    datumIndex: 0,
  };

  const layout = layoutTower(spec);

  assert.equal(layout.rootHeight, ROOT_HEIGHT.roman);
  assert.deepEqual(layout.floors, []);
  assert.equal(layout.datumY, ROOT_HEIGHT.roman);
  assert.equal(layout.top, ROOT_HEIGHT.roman);
});

test('layoutTower: datum sits at the top of the founding floors, and top sums every floor', () => {
  const floors: Floor[] = [
    floor({ id: 'a', size: 'small' }),
    floor({ id: 'b', size: 'medium' }),
    floor({ id: 'c', size: 'large' }),
  ];
  const spec: TowerSpec = {
    id: 'acme/widgets#founding',
    repo: 'acme/widgets',
    kind: 'founding',
    root: 'gothic',
    floors,
    datumIndex: floors.length,
  };

  const layout = layoutTower(spec);

  // Compare with a tolerance: floating-point addition order (root + small +
  // medium + large, accumulated left to right, matching layoutTower itself)
  // is not guaranteed bit-identical to any other grouping of the same sum.
  const expectedTop = ROOT_HEIGHT.gothic + FLOOR_HEIGHT.small + FLOOR_HEIGHT.medium + FLOOR_HEIGHT.large;
  assert.ok(Math.abs(layout.top - expectedTop) < 1e-9);
  assert.equal(layout.datumY, layout.top);

  // Floors stack bottom to top in the order given, starting just above the root.
  assert.equal(layout.floors[0].y0, ROOT_HEIGHT.gothic);
  assert.equal(layout.floors[0].h, FLOOR_HEIGHT.small);
  assert.equal(layout.floors[1].y0, ROOT_HEIGHT.gothic + FLOOR_HEIGHT.small);
  assert.equal(layout.floors[2].y0, ROOT_HEIGHT.gothic + FLOOR_HEIGHT.small + FLOOR_HEIGHT.medium);
});

test('layoutTower: datum can sit below the top when floors exist above it', () => {
  const floors: Floor[] = [floor({ id: 'a', size: 'small' }), floor({ id: 'b', size: 'large' })];
  const spec: TowerSpec = {
    id: 'acme/widgets#founding',
    repo: 'acme/widgets',
    kind: 'founding',
    root: 'pagoda',
    floors,
    datumIndex: 1,
  };

  const layout = layoutTower(spec);

  assert.equal(layout.datumY, ROOT_HEIGHT.pagoda + FLOOR_HEIGHT.small);
  assert.equal(layout.top, ROOT_HEIGHT.pagoda + FLOOR_HEIGHT.small + FLOOR_HEIGHT.large);
});
