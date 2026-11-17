// The ride's dossier line under a scar (final review M5): the verdict is said in the ink, as every other fact on the
// caption, with the inspection page's small failed square before it; no coloured word on a frame of ink and bronze.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const style = readFileSync(new URL('../app/src/ui/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...style.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim().replace(/\s+/g, ' '), m[2]] as const);
const FAIL_LINE = ".ride-dossier-body[data-verdict='fail'] .ride-dossier-line";

test("a failed floor's dossier line keeps the ink: no colour of its own", () => {
  for (const [sel, body] of rules) {
    if (!sel.split(',').some((s) => s.trim() === FAIL_LINE)) continue;
    assert.doesNotMatch(body, /(^|[;\s])color\s*:/, `${sel} sets no colour on the words`);
  }
});

test("a failed floor's dossier line carries the inspection's failed square before it", () => {
  const mark = rules.find(([sel]) => sel.split(',').some((s) => s.trim() === `${FAIL_LINE}::before`));
  assert.ok(mark, 'the failed line has a mark (::before)');
  const body = mark[1];
  assert.match(body, /content\s*:\s*''/);
  const w = Number(/width\s*:\s*(\d+)px/.exec(body)?.[1]);
  const h = Number(/height\s*:\s*(\d+)px/.exec(body)?.[1]);
  assert.ok(w > 0 && w === h && w <= 10, `a small square (${w} by ${h} px)`);
  assert.match(body, /border\s*:\s*1\.5px solid var\(--err\)/, 'drawn as the inspection page draws a failed verdict');
  assert.doesNotMatch(body, /border-radius|box-shadow|filter/, 'a square: no dot, no glow');
});
