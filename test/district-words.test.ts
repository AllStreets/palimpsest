/**
 * The district page's words (Task 40): where each check came from, and which
 * screenshot routes it accepts. Pure functions, no DOM.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isRoute, sourceOf } from '../app/src/ui/district-words.js';
import type { RepoChecks } from '../shared/types.js';

const checks = (o: Partial<RepoChecks> = {}): RepoChecks => ({ test: 'npm test', typecheck: null, lint: null, build: 'npm run build', screenshot: null, preview: null, shots: [], install: 'npm ci', ecosystems: ['npm'], detected: true, ...o });

test('a check says detected, set by you, or none', () => {
  assert.equal(sourceOf(checks(), 'test'), 'detected');
  assert.equal(sourceOf(checks(), 'lint'), 'none');
  assert.equal(sourceOf(checks({ test: 'vitest run', detected: false, setByYou: ['test'] }), 'test'), 'set by you');
  assert.equal(sourceOf(checks({ detected: false, setByYou: ['test'] }), 'build'), 'detected', 'only what he changed is his');
  assert.equal(sourceOf(null, 'test'), 'none');
});

test('a check he emptied says none, not set by you', () => {
  assert.equal(sourceOf(checks({ build: null, detected: false, setByYou: ['build'] }), 'build'), 'none');
  assert.equal(sourceOf(checks({ shots: [], detected: true, setByYou: ['shots'] }), 'shots'), 'none');
  assert.equal(sourceOf(checks({ preview: null, setByYou: ['preview'] }), 'preview'), 'none');
});

test('a route starts with a slash and holds no space, control character or backslash', () => {
  assert.equal(isRoute('/settings'), true);
  assert.equal(isRoute('/'), true);
  assert.equal(isRoute('settings'), false);
  assert.equal(isRoute('/a b'), false);
  assert.equal(isRoute('/a\\b'), false);
  assert.equal(isRoute('/\\evil.example'), false);
  assert.equal(isRoute(`/${'x'.repeat(200)}`), false);
});
