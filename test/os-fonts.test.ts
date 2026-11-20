/**
 * The screens' two faces are self-hosted, credited and licensed: every woff2
 * the app ships has a CREDITS row, each new face carries its OFL beside it,
 * and os/fonts.css loads only files that exist.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FONTS = join(ROOT, 'app', 'public', 'fonts');
const CSS = join(ROOT, 'app', 'src', 'ui', 'os', 'fonts.css');

test('every bundled woff2 is credited', () => {
  const credits = readFileSync(join(ROOT, 'CREDITS.md'), 'utf8');
  const rows = credits.split('\n').filter((l) => l.startsWith('|'));
  for (const f of readdirSync(FONTS).filter((x) => x.endsWith('.woff2'))) {
    assert.ok(rows.some((r) => r.includes(`\`${f}\``)), `CREDITS.md has no row for ${f}`);
  }
});

test('the new faces carry the OFL beside them', () => {
  for (const f of ['big-shoulders-OFL.txt', 'azeret-mono-OFL.txt']) {
    const p = join(FONTS, f);
    assert.ok(existsSync(p), `${f} is missing`);
    assert.match(readFileSync(p, 'utf8'), /SIL OPEN FONT LICENSE Version 1\.1/);
  }
});

test('each face is a real woff2', () => {
  for (const f of ['big-shoulders.woff2', 'azeret-mono.woff2']) {
    const p = join(FONTS, f);
    assert.ok(existsSync(p), `${f} is missing`);
    assert.equal(readFileSync(p).subarray(0, 4).toString('latin1'), 'wOF2', `${f} is not woff2`);
  }
});

test('fonts.css points only at files that exist', () => {
  assert.ok(existsSync(CSS), 'os/fonts.css is missing');
  const css = readFileSync(CSS, 'utf8');
  const urls = [...css.matchAll(/url\(\s*['"]?\/fonts\/([^'")]+)['"]?\s*\)/g)].map((m) => m[1]);
  assert.ok(urls.length > 0, 'fonts.css loads nothing');
  for (const u of urls) assert.ok(existsSync(join(FONTS, u)), `fonts.css points at a missing ${u}`);
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(faces.length, 2, 'exactly two @font-face rules');
  for (const body of faces) {
    assert.match(body, /font-weight:\s*100 900\s*;/);
    assert.match(body, /font-display:\s*swap\s*;/);
  }
});
