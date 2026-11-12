import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dropText, qualityGovernor } from '../app/src/city/governor.js';
import { NOTICES_KEPT, noticeStack } from '../app/src/ui/notices.js';

test('each notice dismisses alone', () => {
  const s = noticeStack();
  s.add('The architecture kits did not load.');
  s.add('That tower is not standing in the city just now.');
  s.add('The city stepped down to medium quality.');
  assert.deepEqual(s.texts(), ['The city stepped down to medium quality.', 'That tower is not standing in the city just now.', 'The architecture kits did not load.'], 'newest first');
  assert.equal(s.dismiss('That tower is not standing in the city just now.'), true);
  assert.deepEqual(s.texts(), ['The city stepped down to medium quality.', 'The architecture kits did not load.'], 'the others stand');
  assert.equal(s.dismiss('That tower is not standing in the city just now.'), false, 'a second dismiss finds nothing');
  assert.deepEqual(s.texts(), ['The city stepped down to medium quality.', 'The architecture kits did not load.']);
});

test('a keyed notice replaces its earlier text', () => {
  const s = noticeStack();
  s.add('An audit of harbor-ledger started.', { key: 'audit:harbor-ledger' });
  s.add('That tower is not standing in the city just now.');
  const next = s.add('The audit of harbor-ledger found 3 claims missing.', { key: 'audit:harbor-ledger' });
  assert.equal(next.replaced, true);
  assert.deepEqual(s.texts(), ['The audit of harbor-ledger found 3 claims missing.', 'That tower is not standing in the city just now.'], 'one line for the key, brought to the top');
  assert.equal(s.dismiss('audit:harbor-ledger'), true, 'and it dismisses by its key');
  assert.deepEqual(s.texts(), ['That tower is not standing in the city just now.']);
});

test('the same words twice stand once', () => {
  const s = noticeStack();
  s.add('The tour arrives with the city track.');
  const again = s.add('The tour arrives with the city track.');
  assert.equal(again.replaced, true);
  assert.deepEqual(s.texts(), ['The tour arrives with the city track.']);
});

test('the stack keeps the last three', () => {
  assert.equal(NOTICES_KEPT, 3);
  const s = noticeStack();
  for (const t of ['one', 'two', 'three', 'four']) s.add(t);
  assert.deepEqual(s.texts(), ['four', 'three', 'two']);
  assert.deepEqual(s.list().map((n) => n.key), ['four', 'three', 'two'], 'an unkeyed notice is keyed by its words');
});

test('the quality-drop notice names the frame rate and the triangles it saw', () => {
  assert.equal(dropText({ fps: 41.2, triangles: 13_240_000 }, true), 'The city stepped down to medium quality: 41 fps and 13.2M triangles from home.');
  assert.equal(dropText({ fps: 58.6, triangles: 25_050_000 }, false), 'The city stepped down to medium quality: 59 fps and 25.1M triangles.');
});

test('the governor keeps what it saw when it steps down', () => {
  const g = qualityGovernor();
  assert.equal(g.saw, null);
  // Slow from the start: the warm-up is never judged, so the window it steps down on is all 40 fps.
  let out: 'medium' | null = null;
  for (let t = 0; t < 16_000 && !out; t += 25) out = g.frame(25, 13.2e6);
  assert.equal(out, 'medium');
  const saw = (g as { saw: { fps: number; triangles: number } | null }).saw;
  assert.ok(saw, 'the drop keeps its reading');
  assert.equal(Math.round(saw.fps), 40);
  assert.equal(Math.round(saw.triangles / 1e5), 132);
});

test('the governor reads the recent frames for a drop it did not make', () => {
  const g = qualityGovernor();
  assert.equal(g.reading(), null, 'no frames, no reading');
  for (let t = 0; t < 2000; t += 20) g.frame(20, 9e6);
  const r = g.reading();
  assert.ok(r);
  assert.equal(Math.round(r.fps), 50);
  assert.equal(Math.round(r.triangles / 1e6), 9);
});
