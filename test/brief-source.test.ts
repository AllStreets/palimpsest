/**
 * The Brief on the screens' layer (screens redesign Task 17), held by its
 * source where node cannot build its DOM: the panel's stream is filled
 * through OsPanel.setStream, the sheet is shown through sheet.show (which
 * dressPanel wraps), keys are weighed rather than left as text buttons, and
 * the old dateline is gone with its import.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'src', 'ui');
const src = readFileSync(join(UI, 'brief.ts'), 'utf8');
const words = readFileSync(join(UI, 'brief-words.ts'), 'utf8');

test('the Brief fills its stream through the panel, never a stream of its own', () => {
  assert.match(src, /panel\.setStream\(streamWords\(/);
  assert.doesNotMatch(src, /createStream/);
});

test('the Brief is dressed as the panel and shown through the sheet', () => {
  assert.match(src, /dressPanel\(sheet\)/);
  assert.match(src, /sheet\.show\(\)/);
  assert.doesNotMatch(src, /panel\.show/);
});

test('every key is weighed with its sum, and named with it', () => {
  assert.match(src, /weighKey\([^)]*weightOf\(a\), keySum\(item, a\) \?\? undefined\)/);
  assert.match(src, /keyAria\(item, a, head\)/);
  assert.doesNotMatch(src, /textButton\('brief-act'/);
});

test('the pins are fed the city, and shown and hidden with the screen', () => {
  assert.match(src, /createPins\(parent, sheet\.root, sheet\.body, opts\.city\)/);
  assert.match(src, /pins\.show\(\)/);
  assert.match(src, /pins\.hide\(\)/);
});

test('a run summary is revealed by a sweep, never typed', () => {
  assert.match(src, /brief-sweep/);
  assert.doesNotMatch(src, /typeIn\([^)]*summary/);
});

test('the old dateline is gone', () => {
  assert.doesNotMatch(words, /export function dateline/);
  assert.doesNotMatch(src, /\bdateline\b/);
});
