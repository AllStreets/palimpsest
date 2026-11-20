/**
 * His no-AI-look list, first item: no tracked all-capitals labels. No style
 * sheet of the app sets text in capitals, and no script sets a label in
 * capitals by hand; labels are sentence case in the editorial type.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'app', 'src', 'ui');

/** Every style sheet under app/src/ui, the os/ layer included. */
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const SHEETS = walk(UI).filter((x) => x.endsWith('.css'));

test('no style sheet sets text in tracked capitals', () => {
  assert.ok(SHEETS.some((f) => f.includes(join('ui', 'os'))), 'the os sheets are read');
  for (const path of SHEETS) {
    const f = relative(UI, path);
    const css = readFileSync(path, 'utf8');
    const hits = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, , body]) => /text-transform:\s*uppercase/.test(body) || /font-variant(-caps)?:\s*(all-)?small-caps/.test(body)).map(([, sel]) => sel.trim());
    assert.deepEqual(hits, [], `${f}: capitals in ${hits.join(', ')}`);
  }
});

test('no style sheet tracks its letters wider than 0.04em', () => {
  for (const path of SHEETS) {
    const css = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const [, value] of css.matchAll(/letter-spacing\s*:\s*([^;}]+)/g)) {
      const v = value.trim();
      const em = /^(-?\d*\.?\d+)em$/.exec(v);
      assert.ok(v === 'normal' || v === '0' || (em && Number(em[1]) <= 0.04), `${relative(UI, path)}: letter-spacing ${v}`);
    }
  }
});

test('the brief carries no kicker over its day', () => {
  const src = readFileSync(join(UI, 'brief.ts'), 'utf8');
  assert.ok(!/brief-kicker/.test(src), 'the day is the heading');
});
