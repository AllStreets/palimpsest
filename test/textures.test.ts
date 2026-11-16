import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The scanned texture sets in app/public/textures (Phase 5 Task 14): their weight, that each is used, their credits
// and the order they load in.

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = join(ROOT, 'app', 'public', 'textures');
const files = (): string[] => readdirSync(DIR).filter((f) => !f.startsWith('.')).sort();
const bytes = (fs: string[]): number => fs.reduce((a, f) => a + statSync(join(DIR, f)).size, 0);
const MB = 1_000_000;

/** Every source file under a folder. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.ts$/.test(e.name) ? [join(dir, e.name)] : [],
  );
}

test('the textures folder is at most 24 MB', () => {
  const total = bytes(files());
  assert.ok(total <= 24 * MB, `app/public/textures is ${(total / MB).toFixed(1)} MB`);
});

test('the ironspot set is at most 2.5 MB', () => {
  const set = bytes(files().filter((f) => f.startsWith('ironspot_')));
  assert.ok(set > 0 && set <= 2.5 * MB, `the ironspot set is ${(set / MB).toFixed(2)} MB`);
});

test('every texture listed in materials.ts exists and every file is used', () => {
  // What the city asks for: each file named outright, and each scanned set named as a set (a material built from
  // all three of its maps: materials.ts pbr, the towers' Scan, the ambient facades' SCANS, the river's stone).
  const text = sources(join(ROOT, 'app', 'src')).map((f) => readFileSync(f, 'utf8')).join('\n');
  const asked = new Set<string>();
  for (const m of text.matchAll(/'([a-z]+_(?:diff|nor|arm)\.jpg)'/g)) asked.add(m[1]);
  const sets = new Set<string>();
  for (const m of text.matchAll(/(?:pbr|riverStone)\('([a-z]+)'/g)) sets.add(m[1]);
  for (const m of text.matchAll(/prefix: '([a-z]+)'/g)) sets.add(m[1]);
  const scan = /export type Scan = ([^;]+);/.exec(text);
  assert.ok(scan, 'the towers name their scanned sets (variants.ts Scan)');
  for (const m of scan[1].matchAll(/'([a-z]+)'/g)) sets.add(m[1]);
  for (const s of sets) for (const map of ['diff', 'nor', 'arm']) asked.add(`${s}_${map}.jpg`);
  const have = new Set(files());
  for (const name of asked) assert.ok(have.has(name), `${name} is asked for and is in app/public/textures`);
  for (const name of have) assert.ok(asked.has(name), `${name} is used by the city`);
});

test('CREDITS.md names every texture set and the roots it covers', () => {
  const credits = readFileSync(join(ROOT, 'CREDITS.md'), 'utf8');
  const sets = [...new Set(files().map((f) => f.replace(/_(diff|nor|arm)\.jpg$/, '')))];
  const row = (set: string): string => credits.split('\n').find((l) => l.startsWith(`| \`${set}_*\``)) ?? '';
  for (const set of sets) assert.ok(row(set), `CREDITS.md has a row for ${set}_*`);
  // Every tower root's stone is the sandstone scan recoloured (tower/look.ts stone(): sand, travertine, gothic,
  // limestone, granite), and the Chicago root's brick is the brick scan.
  const sand = row('sand');
  for (const word of ['Beaux-Arts', 'Roman', 'Gothic', 'pagoda', 'Chicago', 'limestone', 'granite', 'travertine']) {
    assert.ok(sand.includes(word), `the sand_* row names ${word}`);
  }
  assert.ok(row('brick').includes('Chicago'), 'the brick_* row names the Chicago root');
});

test('the textures load in the order the home view needs them, the stone, brick, glass and paving first', async () => {
  const { FIRST_SETS, MAPS, TEXTURE_SETS, textureRank } = await import('../app/src/city/materials.js');
  const onDisk = [...new Set(files().map((f) => f.replace(/_(diff|nor|arm)\.jpg$/, '')))].sort();
  assert.deepEqual([...TEXTURE_SETS].sort(), onDisk, 'TEXTURE_SETS lists every set on disk and no other');
  for (const set of TEXTURE_SETS) for (const map of MAPS) assert.ok(files().includes(`${set}_${map}.jpg`), `${set}_${map}.jpg exists`);
  // The first sets are the stone, the brick and the paving (the street floor every view shows), ahead of the metals.
  assert.deepEqual([...FIRST_SETS], TEXTURE_SETS.slice(0, FIRST_SETS.length));
  for (const set of ['sand', 'ashlar', 'granite', 'brick', 'ironspot', 'pave']) assert.ok(FIRST_SETS.includes(set as never), `${set} is a first set`);
  const last = Math.max(...FIRST_SETS.flatMap((s) => MAPS.map((m) => textureRank(`${s}_${m}.jpg`))));
  for (const f of files().filter((x) => !FIRST_SETS.some((s) => x.startsWith(`${s}_`)))) {
    assert.ok(textureRank(f) > last, `${f} loads after the first sets`);
  }
  assert.ok(textureRank('pave_diff.jpg') < textureRank('metal_diff.jpg'), 'the paving loads before the metals');
  // The street floor (ground.ts, street.ts) samples the pave set and the granite: the city never shows before they land.
  for (const f of ['pave_diff.jpg', 'pave_nor.jpg', 'pave_arm.jpg', 'granite_diff.jpg']) assert.ok(textureRank(f) <= last, `${f} is in before the city shows`);
});

test('a decoded scan is let go once it is on the GPU, keeping its size', async () => {
  const M = (await import('../app/src/city/materials.js')) as unknown as Record<string, unknown>;
  const release = M.releaseOnUpload as ((t: import('three').Texture) => void) | undefined;
  assert.ok(release, 'materials.ts lets a scan go after its upload');
  const { Texture } = await import('three');
  let closed = 0;
  const t = new Texture({ width: 2048, height: 1024, close: () => closed++ } as unknown as HTMLImageElement);
  t.onUpdate = release!;
  t.onUpdate(t);
  assert.equal(closed, 1, 'the bitmap is closed');
  assert.deepEqual(t.image, { width: 2048, height: 1024 });
  assert.equal(t.onUpdate, null, 'once');
});
