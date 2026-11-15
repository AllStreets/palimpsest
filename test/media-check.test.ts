/**
 * The README's media budget (Phase 5 ruling 8), on fixture folders: every
 * file in docs/media used, every reference there, alt text in the house
 * style, stills, clips and the film under their caps, and the inline
 * payload counted as a reader's browser fetches it.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { mediaCheck } from '../tools/media-check.js';

const KB = 1024;
const MB = 1024 * 1024;

/** A still WebP of `bytes` bytes: a RIFF header and padding. */
function stillWebp(bytes: number): Buffer {
  const b = Buffer.alloc(bytes);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(bytes - 8, 4);
  b.write('WEBPVP8 ', 8, 'latin1');
  return b;
}

/** An animated AVIF of `bytes` bytes: an ftyp box naming the avis brand, and padding. */
function animatedAvif(bytes: number): Buffer {
  const b = Buffer.alloc(bytes);
  b.writeUInt32BE(24, 0);
  b.write('ftypavis', 4, 'latin1');
  b.writeUInt32BE(0, 12);
  b.write('avifavis', 16, 'latin1');
  return b;
}

function fixture(files: Record<string, Buffer | number>): string {
  const root = mkdtempSync(join(tmpdir(), 'palimpsest-media-check-'));
  const dir = join(root, 'docs', 'media');
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), typeof body === 'number' ? stillWebp(body) : body);
  return dir;
}

function cleanup(dir: string): void {
  rmSync(join(dir, '..', '..'), { recursive: true, force: true });
}

const img = (name: string, alt = 'The city at dusk.'): string => `<img src="docs/media/${name}" alt="${alt}" width="100%" />`;

test('a clean README and folder pass', () => {
  const dir = fixture({ 'hero.webp': 200 * KB });
  try {
    const r = mediaCheck(`# Palimpsest\n\n${img('hero.webp')}\n`, dir);
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
  } finally {
    cleanup(dir);
  }
});

test('a file in docs/media that the README does not use is a problem', () => {
  const dir = fixture({ 'hero.webp': 200 * KB, 'flyover.gif': 300 * KB });
  try {
    const r = mediaCheck(img('hero.webp'), dir);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /flyover\.gif/.test(p) && /not used/.test(p)), r.problems.join('\n'));
    assert.ok(!r.problems.some((p) => /hero\.webp/.test(p)), 'the used one is not named');
  } finally {
    cleanup(dir);
  }
});

test('a missing reference is a problem', () => {
  const dir = fixture({ 'hero.webp': 200 * KB });
  try {
    const r = mediaCheck(`${img('hero.webp')}\n${img('gone.webp')}\n[the week](docs/media/week.mp4)`, dir);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /gone\.webp/.test(p) && /missing/.test(p)), r.problems.join('\n'));
    assert.ok(r.problems.some((p) => /week\.mp4/.test(p) && /missing/.test(p)), r.problems.join('\n'));
  } finally {
    cleanup(dir);
  }
});

test('a still over 450 KB is a problem', () => {
  const dir = fixture({ 'hero.webp': 451 * KB, 'tower.webp': 450 * KB });
  try {
    const r = mediaCheck(`${img('hero.webp')}\n${img('tower.webp')}`, dir);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /hero\.webp/.test(p) && /450 KB/.test(p)), r.problems.join('\n'));
    assert.ok(!r.problems.some((p) => /tower\.webp/.test(p)), 'exactly 450 KB is within the budget');
  } finally {
    cleanup(dir);
  }
});

test('alt text with an em dash is a problem', () => {
  const dir = fixture({ 'hero.webp': 100 * KB, 'tower.webp': 100 * KB, 'root.webp': 100 * KB, 'datum.webp': 100 * KB });
  try {
    const readme = [
      img('hero.webp', 'The city — at dusk.'),
      img('tower.webp', 'A tower -- at dusk.'),
      `<img src="docs/media/root.webp" width="100%" />`,
      `![](docs/media/datum.webp)`,
    ].join('\n');
    const r = mediaCheck(readme, dir);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /hero\.webp/.test(p) && /em dash/.test(p)), r.problems.join('\n'));
    assert.ok(r.problems.some((p) => /tower\.webp/.test(p) && /double hyphen/.test(p)), r.problems.join('\n'));
    assert.ok(r.problems.some((p) => /root\.webp/.test(p) && /no alt text/.test(p)), r.problems.join('\n'));
    assert.ok(r.problems.some((p) => /datum\.webp/.test(p) && /no alt text/.test(p)), r.problems.join('\n'));
  } finally {
    cleanup(dir);
  }
});

test('the inline payload counts the larger of AVIF and its fallback', () => {
  const picture = (alt = 'A flight round the city.') =>
    `<a href="docs/media/flyover.mp4"><picture><source type="image/avif" srcset="docs/media/flyover.avif" />${img('flyover-poster.webp', alt)}</picture></a>`;
  const small = fixture({ 'flyover.avif': animatedAvif(3 * MB), 'flyover-poster.webp': 200 * KB, 'flyover.mp4': 2 * MB });
  try {
    const r = mediaCheck(picture(), small);
    assert.deepEqual(r.problems, []);
    assert.equal(r.payload, 3 * MB, 'the AVIF, the larger, is counted once; the linked MP4 is not fetched on open');
  } finally {
    cleanup(small);
  }
  const fallback = fixture({ 'flyover.avif': animatedAvif(100 * KB), 'flyover-poster.webp': 400 * KB, 'flyover.mp4': 2 * MB });
  try {
    assert.equal(mediaCheck(picture(), fallback).payload, 400 * KB, 'the fallback, when it is the larger');
  } finally {
    cleanup(fallback);
  }
  // Seven 3.9 MB animations inline: each within its 4 MB, together over the 25 MB a reader fetches on open.
  const many: Record<string, Buffer | number> = {};
  const lines: string[] = [];
  for (let i = 0; i < 7; i++) {
    many[`clip${i}.avif`] = animatedAvif(3.9 * MB);
    many[`clip${i}-poster.webp`] = 100 * KB;
    lines.push(`<picture><source type="image/avif" srcset="docs/media/clip${i}.avif" />${img(`clip${i}-poster.webp`)}</picture>`);
  }
  const heavy = fixture(many);
  try {
    const r = mediaCheck(lines.join('\n'), heavy);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => /inline payload/.test(p) && /25 MB/.test(p)), r.problems.join('\n'));
    assert.ok(!r.problems.some((p) => /clip\d\.avif/.test(p)), 'each animation alone is within its cap');
  } finally {
    cleanup(heavy);
  }
});

test('an inline animation over 4 MB, a linked MP4 over 9 MB and the film over 9.5 MB are problems', () => {
  const dir = fixture({
    'ride.avif': animatedAvif(4 * MB + 1),
    'ride-poster.webp': 100 * KB,
    'week.mp4': Buffer.alloc(9 * MB + 1),
    'film.mp4': Buffer.alloc(9.4 * MB),
    'film-poster.webp': 100 * KB,
  });
  try {
    const readme = [
      `<picture><source type="image/avif" srcset="docs/media/ride.avif" />${img('ride-poster.webp')}</picture>`,
      '[the week](docs/media/week.mp4)',
      `<a href="docs/media/film.mp4">${img('film-poster.webp')}</a>`,
    ].join('\n');
    const r = mediaCheck(readme, dir);
    assert.ok(r.problems.some((p) => /ride\.avif/.test(p) && /4 MB/.test(p)), r.problems.join('\n'));
    assert.ok(r.problems.some((p) => /week\.mp4/.test(p) && /9 MB/.test(p)), r.problems.join('\n'));
    assert.ok(!r.problems.some((p) => /film\.mp4/.test(p)), 'the film has its own 9.5 MB');
  } finally {
    cleanup(dir);
  }
});

test('a poster counts as used when its clip is linked', () => {
  const dir = fixture({ 'week.mp4': Buffer.alloc(KB), 'week-poster.webp': 100 * KB, 'commute-poster.webp': 100 * KB });
  try {
    const r = mediaCheck('Watch [the week tour](docs/media/week.mp4).', dir);
    assert.ok(!r.problems.some((p) => /week/.test(p)), r.problems.join('\n'));
    assert.ok(r.problems.some((p) => /commute-poster\.webp/.test(p) && /not used/.test(p)), 'a poster whose clip is not linked is not used');
  } finally {
    cleanup(dir);
  }
});

test('docs/media over 45 MB in all is a problem', () => {
  const files: Record<string, Buffer | number> = {};
  const lines: string[] = [];
  for (let i = 0; i < 6; i++) {
    files[`c${i}.mp4`] = Buffer.alloc(8 * MB);
    lines.push(`[clip ${i}](docs/media/c${i}.mp4)`);
  }
  const dir = fixture(files);
  try {
    const r = mediaCheck(lines.join('\n'), dir);
    assert.ok(r.problems.some((p) => /45 MB/.test(p)), r.problems.join('\n'));
  } finally {
    cleanup(dir);
  }
});

test('the profile snippet beside the media counts its own files as used', () => {
  const dir = fixture({ 'profile.avif': animatedAvif(2 * MB), 'profile.webp': 300 * KB });
  writeFileSync(join(dir, 'profile.md'), '<picture><source type="image/avif" srcset="https://raw.githubusercontent.com/AllStreets/palimpsest/main/docs/media/profile.avif" /><img src="https://raw.githubusercontent.com/AllStreets/palimpsest/main/docs/media/profile.webp" alt="The city at dusk." /></picture>\n');
  try {
    const r = mediaCheck('# Palimpsest\n', dir);
    assert.deepEqual(r.problems, []);
    assert.equal(r.payload, 0, 'the profile is not fetched with the README');
  } finally {
    cleanup(dir);
  }
});

test('a poster counts as used when its clip plays inline as an AVIF', () => {
  const dir = fixture({ 'ride.avif': animatedAvif(2 * MB), 'ride-poster.webp': 100 * KB, 'ride.mp4': Buffer.alloc(KB) });
  try {
    // The AVIF plays inline with its own fallback named elsewhere; the MP4 is not linked.
    const r = mediaCheck(`<picture><source type="image/avif" srcset="docs/media/ride.avif" /><img src="docs/media/hero.webp" alt="The ride." /></picture>`, dir);
    assert.ok(!r.problems.some((p) => /ride-poster\.webp/.test(p)), r.problems.join('\n'));
    assert.ok(r.problems.some((p) => /ride\.mp4/.test(p) && /not used/.test(p)), 'the unlinked MP4 is still unused');
  } finally {
    cleanup(dir);
  }
});
