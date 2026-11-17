/**
 * The README's media budget (Phase 5 ruling 8):
 *
 *   npm run media:check
 *
 * Every file in docs/media is used by README.md (a clip's poster counts
 * when the clip is linked or its AVIF is played inline, and the profile snippet's own files count when
 * a `.md` beside them names them); every reference into docs/media exists;
 * every image has alt text with no em dash, double hyphen or emoji; each
 * still is at most 450 KB, each inline animation at most 4 MB, each linked
 * MP4 at most 9 MB and the film at most 9.5 MB; the README's inline payload
 * (every `src` and `srcset` a reader's browser fetches on open, the larger
 * of a picture's AVIF and its fallback counted) at most 25 MB; and
 * docs/media in all at most 45 MB. Exits 1 naming each problem.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KB = 1024;
const MB = 1024 * 1024;

export const BUDGET = {
  still: 450 * KB,
  inlineAnimation: 4 * MB,
  linkedMp4: 9 * MB,
  film: 9.5 * MB,
  payload: 25 * MB,
  folder: 45 * MB,
} as const;

/** The film's own file, held to its own cap. */
const FILM = 'film.mp4';
const MEDIA_EXT = new Set(['.webp', '.avif', '.png', '.jpg', '.jpeg', '.gif', '.mp4', '.webm', '.mov', '.svg']);

export interface MediaCheck {
  ok: boolean;
  problems: string[];
  /** Bytes a reader's browser fetches for the README's images on open. */
  payload: number;
}

interface Ref {
  /** The path inside docs/media. */
  name: string;
  /** Fetched on open (src, srcset) or only on a click (href, a markdown link). */
  inline: boolean;
}

const fmt = (n: number): string => (n >= MB ? `${(n / MB).toFixed(1)} MB` : `${Math.round(n / KB)} KB`);

/** The part of a URL inside docs/media, or null for anything else. */
function inMedia(url: string): string | null {
  const m = /(?:^|\/)docs\/media\/([^\s?#"')]+)/.exec(url.trim());
  return m ? decodeURIComponent(m[1]) : null;
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? '') : null;
};

/** Each candidate URL in a srcset. */
const srcsetUrls = (v: string): string[] =>
  v
    .split(',')
    .map((c) => c.trim().split(/\s+/)[0])
    .filter(Boolean);

function altProblems(alt: string | null): string[] {
  if (alt === null || alt.trim() === '') return ['has no alt text'];
  const out: string[] = [];
  if (/—/.test(alt)) out.push('has an em dash in its alt text');
  if (/--/.test(alt)) out.push('has a double hyphen in its alt text');
  if (/\p{Extended_Pictographic}/u.test(alt)) out.push('has an emoji in its alt text');
  return out;
}

/** True for an animated image: a GIF, a WebP with an ANIM chunk, an AVIF whose ftyp names the avis brand. */
function animated(path: string): boolean {
  const ext = extname(path).toLowerCase();
  if (ext === '.gif') return true;
  if (ext !== '.webp' && ext !== '.avif') return false;
  const fd = openSync(path, 'r');
  try {
    const head = Buffer.alloc(4096);
    const n = readSync(fd, head, 0, head.length, 0);
    const s = head.subarray(0, n).toString('latin1');
    if (ext === '.webp') return s.includes('ANIM');
    const size = head.readUInt32BE(0);
    return s.slice(4, 8) === 'ftyp' && s.slice(8, Math.min(size, n)).includes('avis');
  } finally {
    closeSync(fd);
  }
}

/** Every reference into docs/media in a README, and the pictures and images a browser fetches on open. */
function parse(readme: string): { refs: Ref[]; groups: string[][]; images: Array<{ names: string[]; alt: string | null; label: string }> } {
  const refs: Ref[] = [];
  const groups: string[][] = [];
  const images: Array<{ names: string[]; alt: string | null; label: string }> = [];
  const add = (url: string, inline: boolean): string | null => {
    const name = inMedia(url);
    if (name) refs.push({ name, inline });
    return name;
  };
  // A <picture> fetches one of its candidates: its group's payload is the largest.
  const inPicture = new Set<number>();
  for (const pic of readme.matchAll(/<picture\b[\s\S]*?<\/picture>/gi)) {
    const names: string[] = [];
    for (const tag of pic[0].matchAll(/<(source|img)\b[^>]*>/gi)) {
      inPicture.add(pic.index + (tag.index ?? 0));
      const srcset = attr(tag[0], 'srcset');
      if (srcset) for (const u of srcsetUrls(srcset)) {
        const n = add(u, true);
        if (n) names.push(n);
      }
      const src = attr(tag[0], 'src');
      if (src) {
        const n = add(src, true);
        if (n) names.push(n);
      }
      if (tag[1].toLowerCase() === 'img') images.push({ names: names.slice(), alt: attr(tag[0], 'alt'), label: inMedia(src ?? '') ?? src ?? 'an image' });
    }
    if (names.length) groups.push(names);
  }
  for (const tag of readme.matchAll(/<img\b[^>]*>/gi)) {
    if (inPicture.has(tag.index)) continue;
    const names: string[] = [];
    const src = attr(tag[0], 'src');
    if (src) {
      const n = add(src, true);
      if (n) names.push(n);
    }
    const srcset = attr(tag[0], 'srcset');
    if (srcset) for (const u of srcsetUrls(srcset)) {
      const n = add(u, true);
      if (n) names.push(n);
    }
    if (names.length) groups.push(names);
    images.push({ names, alt: attr(tag[0], 'alt'), label: inMedia(src ?? '') ?? src ?? 'an image' });
  }
  for (const a of readme.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(a[0], 'href');
    if (href) add(href, false);
  }
  // Markdown: ![alt](url) is an image fetched on open; [text](url) is a link.
  for (const m of readme.matchAll(/(!?)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const image = m[1] === '!';
    const n = add(m[3], image);
    if (image) {
      if (n) groups.push([n]);
      images.push({ names: n ? [n] : [], alt: m[2], label: n ?? m[3] });
    }
  }
  return { refs, groups, images };
}

export function mediaCheck(readme: string, dir: string): MediaCheck {
  const problems: string[] = [];
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile() && !f.startsWith('.')) : [];
  const media = files.filter((f) => MEDIA_EXT.has(extname(f).toLowerCase()));
  const size = (name: string): number => (existsSync(join(dir, name)) ? statSync(join(dir, name)).size : 0);
  const { refs, groups, images } = parse(readme);

  const used = new Set(refs.map((r) => r.name));
  // A snippet kept beside the media (the profile's) uses its own files; they are not fetched with the README.
  for (const md of files.filter((f) => extname(f).toLowerCase() === '.md')) {
    for (const r of parse(readFileSync(join(dir, md), 'utf8')).refs) used.add(r.name);
  }
  // A poster is used when its clip is linked, or played inline as an AVIF (the poster is its fallback).
  for (const r of refs) if (/\.(mp4|avif)$/i.test(r.name)) used.add(r.name.replace(/\.(mp4|avif)$/i, '-poster.webp'));

  for (const f of media) if (!used.has(f)) problems.push(`docs/media/${f} is not used by the README`);
  const missing = new Set<string>();
  for (const r of refs) if (!existsSync(join(dir, r.name)) && !missing.has(r.name)) {
    missing.add(r.name);
    problems.push(`docs/media/${r.name} is referenced but missing`);
  }

  for (const im of images) for (const p of altProblems(im.alt)) problems.push(`${im.label} ${p}`);

  const inline = new Set(refs.filter((r) => r.inline).map((r) => r.name));
  for (const f of media) {
    const n = size(f);
    const ext = extname(f).toLowerCase();
    if (ext === '.mp4' || ext === '.webm' || ext === '.mov') {
      const cap = f === FILM ? BUDGET.film : BUDGET.linkedMp4;
      if (n > cap) problems.push(`docs/media/${f} is ${fmt(n)}, over the ${f === FILM ? '9.5 MB for the film' : '9 MB for a linked clip'}`);
    } else if (animated(join(dir, f))) {
      if (inline.has(f) && n > BUDGET.inlineAnimation) problems.push(`docs/media/${f} is ${fmt(n)}, over the 4 MB for an inline animation`);
    } else if (n > BUDGET.still) {
      problems.push(`docs/media/${f} is ${fmt(n)}, over the 450 KB for a still`);
    }
  }

  // Each group (a picture, or a bare image) fetched once, at its largest candidate; a file in two groups counted once.
  let payload = 0;
  const counted = new Set<string>();
  for (const g of groups) {
    const fresh = g.filter((n) => !counted.has(n));
    if (!fresh.length) continue;
    payload += Math.max(...fresh.map(size));
    for (const n of g) counted.add(n);
  }
  if (payload > BUDGET.payload) problems.push(`the README's inline payload is ${fmt(payload)}, over 25 MB`);

  const total = files.reduce((s, f) => s + size(f), 0);
  if (total > BUDGET.folder) problems.push(`docs/media is ${fmt(total)} in all, over 45 MB`);

  return { ok: problems.length === 0, problems, payload };
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const r = mediaCheck(readFileSync(join(root, 'README.md'), 'utf8'), join(root, 'docs', 'media'));
  for (const p of r.problems) console.error(p);
  console.log(`${r.ok ? 'Within the budget' : `${r.problems.length} problems`}: inline payload ${fmt(r.payload)}.`);
  process.exit(r.ok ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

