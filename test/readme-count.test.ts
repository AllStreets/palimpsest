/**
 * The README's test count (Phase 5 Task 30): its total is the sum of its
 * parts, and the Python and cargo parts are the tests those suites hold. The
 * Node part is checked against a clean clone's `npm test` at launch, since
 * some Node tests are made in loops and cannot be counted from the source.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const n = (s: string): number => Number(s.replace(/,/g, ''));

function walk(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name), ext) : e.name.endsWith(ext) ? [join(dir, e.name)] : []));
}

test("the README's test count adds up, and its Python and cargo parts are the suites' own", () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const m = /There are ([\d,]+) tests: ([\d,]+) in Node .*?, ([\d,]+) in Python .*?, and ([\d,]+) for the app shell/.exec(readme);
  assert.ok(m, 'the README states its test count in its own sentence');
  const [total, node, python, cargo] = m.slice(1).map(n);
  assert.equal(total, node + python + cargo, 'the total is the sum of its parts');
  const py = readdirSync(join(ROOT, 'trainer'))
    .filter((f) => /^test_.*\.py$/.test(f))
    .reduce((a, f) => a + (readFileSync(join(ROOT, 'trainer', f), 'utf8').match(/^\s*def test_/gm) ?? []).length, 0);
  assert.equal(python, py, `the Python part is the trainer's tests (${py})`);
  const rs = walk(join(ROOT, 'src-tauri', 'src'), '.rs').reduce((a, f) => a + (readFileSync(f, 'utf8').match(/#\[(?:tokio::)?test\]/g) ?? []).length, 0);
  assert.equal(cargo, rs, `the cargo part is the app shell's tests (${rs})`);
});
