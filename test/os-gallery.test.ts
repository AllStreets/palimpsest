/**
 * The screens' debug gallery and its stills harness: the gallery is loaded
 * only through the debug handle, by dynamic import, so the normal path never
 * carries it; the harness shares one launch and one guard between the Brief's
 * tool and the gallery's, and that guard refuses the real engine's ports and
 * a missing scratch home.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');
const uncomment = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('main.ts loads the gallery only by dynamic import, behind the debug handle', () => {
  const main = uncomment(read('app/src/main.ts'));
  assert.ok(!/^\s*import\s(?!type\b)[^;]*['"]\.\/ui\/os\/gallery(\.js)?['"]/m.test(main), 'main.ts imports the gallery statically');
  assert.match(main, /import\(\s*['"]\.\/ui\/os\/gallery(\.js)?['"]\s*\)/, 'main.ts loads the gallery with import()');
  // The city the pins stand on (Task 10): one OsCity, built once, handed to the gallery; pins.ts comes in as a type only.
  assert.match(main, /mountGallery\(document\.body,\s*kind,\s*osCity\)/, 'the gallery is given the OsCity');
  assert.ok(!/^\s*import\s(?!type\b)[^;]*['"]\.\/ui\/os\/pins(\.js)?['"]/m.test(main), 'main.ts imports pins.ts statically');
  assert.equal([...main.matchAll(/const osCity\b/g)].length, 1, 'one OsCity');
  assert.match(main, /osGallery\s*\(\s*kind\s*:\s*GalleryKind\s*\|\s*null\s*\)\s*:\s*void/, 'the debug handle declares osGallery(kind: GalleryKind | null): void');
  assert.match(main, /import\s+type\s*\{[^}]*\bGalleryKind\b[^}]*\}\s*from\s*['"]\.\/ui\/os\/gallery(\.js)?['"]/, 'GalleryKind comes in as a type only');
});

test('the gallery names its six kinds and mounts with an unmount', () => {
  const src = read('app/src/ui/os/gallery.ts');
  const kinds = /export type GalleryKind\s*=\s*([^;]+);/.exec(src);
  assert.ok(kinds, 'gallery.ts exports GalleryKind');
  const names = [...kinds[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual(names, ['type', 'panel', 'controls', 'readouts', 'pins', 'terminal']);
  assert.match(src, /export function mountGallery\(parent: HTMLElement, kind: GalleryKind, city\?: OsCity\): \(\) => void/);
  assert.match(src, /import\s+['"]\.\/index\.css['"]/, 'the gallery brings the os layer with it');
});

test('figures are set in tabular numbers', () => {
  const tokens = uncomment(read('app/src/ui/os/tokens.css'));
  const rule = /\.os-figs\s*\{([^}]*)\}/.exec(tokens);
  assert.ok(rule, 'tokens.css has an .os-figs rule');
  assert.match(rule[1], /font-variant-numeric:\s*tabular-nums/);
  assert.match(rule[1], /font-family:\s*var\(--os-mono\)/);
});

test('the harness shares the Brief tool\'s helpers, launch and guards', async () => {
  const h = await import('../tools/redesign-harness.js');
  for (const fn of ['view', 'settle', 'ready', 'framings', 'toCity', 'launch', 'redesignHome', 'redesignPort', 'guardPort'] as const) {
    assert.equal(typeof h[fn], 'function', `the harness exports ${fn}`);
  }
  assert.throws(() => h.guardPort(4770), /4770/);
  assert.throws(() => h.guardPort(4771), /4771/);
  assert.equal(h.guardPort(4789), 4789);
  const was = process.env.REDESIGN_HOME;
  delete process.env.REDESIGN_HOME;
  try {
    assert.throws(() => h.redesignHome(), /REDESIGN_HOME/);
  } finally {
    if (was !== undefined) process.env.REDESIGN_HOME = was;
  }
  for (const tool of ['tools/redesign-brief.ts', 'tools/os-stills.ts']) {
    const src = uncomment(read(tool));
    assert.match(src, /from '\.\/redesign-harness\.js'/, `${tool} uses the harness`);
    assert.ok(!/startServer|chromium\.launch|4770/.test(src), `${tool} launches or guards on its own`);
  }
});
