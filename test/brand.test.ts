/**
 * The mark's files (Phase 5 Task 22): the icon set Tauri bundles carries every
 * size macOS asks for, and the images the splash, the running head and the
 * browser tab load are where their pages look for them.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The icns element types macOS reads, by the pixel size each holds. */
const ICNS_TYPES: Record<string, number> = {
  ic04: 16, // iconutil writes 16 and 32 as ARGB (ic04, ic05)
  ic05: 32,
  icp4: 16,
  icp5: 32,
  icp6: 64,
  ic07: 128,
  ic08: 256,
  ic09: 512,
  ic10: 1024,
  ic11: 32, // 16 @2x
  ic12: 64, // 32 @2x
  ic13: 256, // 128 @2x
  ic14: 512, // 256 @2x
};

function icnsSizes(file: string): Set<number> {
  const buf = readFileSync(file);
  assert.equal(buf.toString('latin1', 0, 4), 'icns', 'icns magic');
  const sizes = new Set<number>();
  let at = 8;
  while (at + 8 <= buf.length) {
    const type = buf.toString('latin1', at, at + 4);
    const len = buf.readUInt32BE(at + 4);
    if (ICNS_TYPES[type]) sizes.add(ICNS_TYPES[type]);
    if (len < 8) break;
    at += len;
  }
  return sizes;
}

function pngSize(file: string): [number, number] {
  const buf = readFileSync(file);
  assert.equal(buf.toString('latin1', 1, 4), 'PNG', `${file} is a PNG`);
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test('icon.icns carries 16, 32, 64, 128, 256, 512 and 1024', () => {
  const sizes = icnsSizes(join(ROOT, 'src-tauri', 'icons', 'icon.icns'));
  for (const want of [16, 32, 64, 128, 256, 512, 1024]) assert.ok(sizes.has(want), `icns holds ${want} px (has ${[...sizes].sort((a, b) => a - b).join(', ')})`);
});

test('the bundled PNG icons are the sizes their names say', () => {
  for (const [name, size] of [
    ['32x32.png', 32],
    ['128x128.png', 128],
    ['128x128@2x.png', 256],
    ['icon.png', 512],
  ] as const) {
    assert.deepEqual(pngSize(join(ROOT, 'src-tauri', 'icons', name)), [size, size], name);
  }
});

test('the splash, the running head and the browser tab find their marks', () => {
  const splash = readFileSync(join(ROOT, 'src-tauri', 'splash', 'index.html'), 'utf8');
  const markSrc = /<img[^>]*class="mark"[^>]*src="([^"]+)"/.exec(splash)?.[1];
  assert.ok(markSrc, 'the splash has an <img class="mark">');
  assert.ok(existsSync(join(ROOT, 'src-tauri', 'splash', markSrc!)), `the splash mark ${markSrc} exists`);

  const index = readFileSync(join(ROOT, 'app', 'index.html'), 'utf8');
  const favicon = /<link rel="icon"[^>]*href="\/([^"]+)"/.exec(index)?.[1];
  assert.ok(favicon, 'app/index.html links a favicon');
  assert.deepEqual(pngSize(join(ROOT, 'app', 'public', favicon!)), [32, 32], 'the favicon is 32 px');
  assert.deepEqual(pngSize(join(ROOT, 'app', 'public', 'brand', 'favicon-180.png')), [180, 180], 'the touch icon is 180 px');

  const runhead = readFileSync(join(ROOT, 'app', 'src', 'ui', 'runhead.ts'), 'utf8');
  const head = /['"]\/brand\/(mark-18[^'"]*\.png)['"]/.exec(runhead)?.[1];
  assert.ok(head, 'the running head loads /brand/mark-18*.png');
  assert.deepEqual(pngSize(join(ROOT, 'app', 'public', 'brand', 'mark-18.png')), [18, 18], 'the running head mark is 18 px');
  assert.deepEqual(pngSize(join(ROOT, 'app', 'public', 'brand', 'mark-18@2x.png')), [36, 36], 'and its @2x is 36 px');
});

test('the social preview is 1280 by 640 and under a megabyte', () => {
  const file = join(ROOT, 'docs', 'brand', 'social.png');
  assert.deepEqual(pngSize(file), [1280, 640]);
  assert.ok(readFileSync(file).length <= 1_000_000, 'at most 1 MB');
});
