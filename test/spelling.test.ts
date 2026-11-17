// One spelling of the sample's harbor (audit 2026-11-17): the repo is harbor-ledger and his locale is US, so the copy,
// the palette and the sample's prose say "harbor" everywhere, never the British spelling beside it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BRITISH = new RegExp(['harb', 'our'].join(''), 'i');

test('no tracked file spells harbor the British way', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter((f) => f && /\.(ts|md|json|html|css|mjs)$/.test(f) && !f.startsWith('node_modules'));
  assert.ok(files.length > 100, 'the tracked files are read');
  const hits = files.filter((f) => {
    try {
      return BRITISH.test(readFileSync(`${ROOT}/${f}`, 'utf8'));
    } catch {
      return false;
    }
  });
  assert.deepEqual(hits, []);
});
