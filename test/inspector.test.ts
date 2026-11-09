import assert from 'node:assert/strict';
import { test } from 'node:test';

import { floorDate, floorLink } from '../app/src/ui/inspector.js';
import type { Floor } from '../shared/types.js';

function floor(p: Partial<Floor>): Floor {
  return {
    id: 'acme/site#x',
    repo: 'acme/site',
    kind: 'commits',
    refs: [],
    title: 't',
    at: '2025-03-04T10:00:00Z',
    era: 'stone',
    size: 'small',
    lines: 1,
    claude: false,
    founding: true,
    url: null,
    ...p,
  };
}

test('a PR floor links to its own url', () => {
  const l = floorLink(floor({ kind: 'pr', refs: ['#42'], url: 'https://github.com/acme/site/pull/42' }));
  assert.deepEqual(l, { text: '#42', href: 'https://github.com/acme/site/pull/42', more: 0 });
});

test('a single commit links to the commit', () => {
  const l = floorLink(floor({ refs: ['abc1234'] }));
  assert.equal(l.href, 'https://github.com/acme/site/commit/abc1234');
});

test('a commit range links to the compare view with three dots', () => {
  const l = floorLink(floor({ refs: ['abc1234..def5678'] }));
  assert.equal(l.href, 'https://github.com/acme/site/compare/abc1234...def5678');
  assert.equal(l.text, 'abc1234..def5678');
});

test('a merged floor links its first ref and counts the rest', () => {
  // The floor url belongs to the later PR, so the first ref (a different PR) gets its own pull link.
  const l = floorLink(floor({ kind: 'pr', refs: ['#7', 'abc1234', '#9'], url: 'https://github.com/acme/site/pull/9' }));
  assert.deepEqual(l, { text: '#7', href: 'https://github.com/acme/site/pull/7', more: 2 });
});

test('a commit-first merged floor links the commit, not the PR url', () => {
  const l = floorLink(floor({ kind: 'pr', refs: ['abc1234', '#9'], url: 'https://github.com/acme/site/pull/9' }));
  assert.equal(l.href, 'https://github.com/acme/site/commit/abc1234');
  assert.equal(l.more, 1);
});

test('floor dates read as month, day, year', () => {
  assert.equal(floorDate('2025-03-04T10:00:00Z'), 'Mar 4, 2025');
  assert.equal(floorDate('not a date'), '');
});
