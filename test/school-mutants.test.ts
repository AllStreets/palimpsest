/**
 * Planted bugs (Phase 4 Task 19, ruling 20): `mutate()` is pure, so these
 * tests need no home, no repo and no process.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { mutate } from '../engine/school/mutants.js';

const SRC = [
  'export function max(a, b) {',
  '  if (a > b) return a;',
  '  return b;',
  '}',
  'const note = "a < b and true";',
  "const other = 'x === y';",
  '// if (c <= d) return true;',
  '/* a block that says e >= f',
  '   and g && h */',
  'const tpl = `n < ${0} || m`;',
  'export const ok = (x, y) => x !== y && !x;',
  'export const flag = true;',
  'export function first(p, q) {',
  '  return q + 1;',
  '}',
].join('\n');

test('mutate flips a comparison, skips strings and comments, and is deterministic', () => {
  const all = mutate('src/m.js', SRC, 1000, 1);
  const at = (line: number) => all.filter((m) => m.line === line);

  const flipped = at(2).find((m) => m.op === 'comparison');
  assert.ok(flipped, 'the comparison on line 2 is flipped');
  assert.equal(flipped.original, '  if (a > b) return a;');
  assert.equal(flipped.mutated, '  if (a <= b) return a;');
  assert.equal(flipped.file, 'src/m.js');

  // Nothing inside a string, a template's text or a comment is touched.
  for (const line of [5, 6, 7, 8, 9]) assert.deepEqual(at(line), [], `line ${line} is a string or a comment`);
  for (const m of at(10)) assert.match(m.mutated, /`n < \$\{/, 'the template text stays as it was');

  // Each mutant changes exactly its own line, and never to the same text.
  const lines = SRC.split('\n');
  for (const m of all) {
    assert.equal(lines[m.line - 1], m.original);
    assert.notEqual(m.mutated, m.original);
  }

  // The same input and seed give the same mutants in the same order; max cuts the list.
  assert.deepEqual(mutate('src/m.js', SRC, 1000, 1), all);
  const three = mutate('src/m.js', SRC, 3, 1);
  assert.equal(three.length, 3);
  assert.deepEqual(three, mutate('src/m.js', SRC, 3, 1));
  assert.deepEqual(
    new Set(mutate('src/m.js', SRC, 1000, 7).map((m) => `${m.line}:${m.mutated}`)),
    new Set(all.map((m) => `${m.line}:${m.mutated}`)),
    'another seed reorders the same mutants',
  );
});

test('mutate knows the six one-line bugs', () => {
  const all = mutate('src/m.js', SRC, 1000, 1);
  const has = (line: number, mutated: string) => all.some((m) => m.line === line && m.mutated === mutated);
  assert.ok(has(11, 'export const ok = (x, y) => x !== y || !x;'), 'swap && and ||');
  assert.ok(has(11, 'export const ok = (x, y) => x !== y && x;'), 'drop a !');
  assert.ok(has(11, 'export const ok = (x, y) => x === y && !x;'), 'flip !==');
  assert.ok(has(12, 'export const flag = false;'), 'swap true and false');
  assert.ok(has(14, '  return q + 2;'), 'off by one');
  assert.ok(has(14, '  return p;'), 'return the first argument');
  assert.deepEqual(new Set(all.map((m) => m.op)), new Set(['comparison', 'off-by-one', 'logic', 'negation', 'boolean', 'first-arg']));
});

test('mutate plants nothing in a test file or a file that is not source', () => {
  assert.deepEqual(mutate('test/m.test.js', SRC, 1000, 1), []);
  assert.deepEqual(mutate('README.md', 'if a > b then true', 1000, 1), []);
});

test('mutate reads # comments and Python words in Python', () => {
  const py = ['def f(a, b):', '    # a < b is fine', '    return a < b and True', 's = "x > y"'].join('\n');
  const all = mutate('src/f.py', py, 1000, 1);
  assert.deepEqual(all.filter((m) => m.line === 2 || m.line === 4), []);
  const has = (mutated: string) => all.some((m) => m.line === 3 && m.mutated === mutated);
  assert.ok(has('    return a >= b and True'));
  assert.ok(has('    return a < b or True'));
  assert.ok(has('    return a < b and False'));
  assert.ok(has('    return a'));
});
