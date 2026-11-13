/**
 * His no-AI-look list, first item: no tracked all-capitals labels. No style
 * sheet of the app sets text in capitals, and no script sets a label in
 * capitals by hand; labels are sentence case in the editorial type.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'src', 'ui');

test('no style sheet sets text in tracked capitals', () => {
  for (const f of readdirSync(UI).filter((x) => x.endsWith('.css'))) {
    const css = readFileSync(join(UI, f), 'utf8');
    const hits = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, , body]) => /text-transform:\s*uppercase/.test(body) || /font-variant(-caps)?:\s*(all-)?small-caps/.test(body)).map(([, sel]) => sel.trim());
    assert.deepEqual(hits, [], `${f}: capitals in ${hits.join(', ')}`);
  }
});

test('the brief carries no kicker over its day', () => {
  const src = readFileSync(join(UI, 'brief.ts'), 'utf8');
  assert.ok(!/brief-kicker/.test(src), 'the day is the heading');
});
