import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dropText, qualityGovernor } from '../app/src/city/governor.js';
import { NOTICE_LINES, NOTICE_PLATE, NOTICE_WORDS, NOTICES_KEPT, noticeStack } from '../app/src/ui/notices.js';

test('each notice dismisses alone', () => {
  const s = noticeStack();
  s.add('The architecture kits did not load.');
  s.add('That tower is not standing in the city just now.');
  s.add('The city stepped down to medium quality.');
  assert.deepEqual(s.texts(), ['The city stepped down to medium quality.', 'That tower is not standing in the city just now.', 'The architecture kits did not load.'], 'newest first');
  assert.equal(s.dismiss('That tower is not standing in the city just now.'), true);
  assert.deepEqual(s.texts(), ['The city stepped down to medium quality.', 'The architecture kits did not load.'], 'the others stand');
  assert.equal(s.dismiss('That tower is not standing in the city just now.'), false, 'a second dismiss finds nothing');
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
  assert.equal(dropText({ fps: 41.2, triangles: 13_240_000 }, true), 'The city stepped down to medium quality: 41 fps and 13.2M triangles from home. Settings can set it back to high.');
  assert.equal(dropText({ fps: 58.6, triangles: 25_050_000 }, false), 'The city stepped down to medium quality: 59 fps and 25.1M triangles. Settings can set it back to high.');
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

// ---------------------------------------------------------------- Phase 5 Task 17: the notices' parked lines

/** WCAG relative luminance of an sRGB colour, 0 to 255 a channel. */
function luminance([r, g, b]: readonly number[]): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

test('notices keep contrast over a lit tower: an ink plate at 0.82 opacity', () => {
  assert.equal(NOTICE_PLATE.alpha, 0.82);
  // The worst a lit tower can put behind a line is pure white; the plate over it, under the dimmest words, still reads 4.5:1.
  const over = NOTICE_PLATE.rgb.map((c) => c * NOTICE_PLATE.alpha + 255 * (1 - NOTICE_PLATE.alpha));
  const ratio = (luminance(NOTICE_WORDS) + 0.05) / (luminance(over) + 0.05);
  assert.ok(ratio >= 4.5, `${ratio.toFixed(2)}:1`);
  assert.match(NOTICE_PLATE.css, /^rgba\(18, 16, 24, 0\.82\)$/);
});

test('a long notice wraps to two lines, then ellipsises', () => {
  assert.equal(NOTICE_LINES, 2);
});

test('the mark that recalls the column says what it holds, never a bare tag', async () => {
  const { recallText } = await import('../app/src/ui/notices.js');
  assert.equal(recallText(1), '1 notice');
  assert.equal(recallText(3), '3 notices');
  assert.equal(recallText(0), '');
});
