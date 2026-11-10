/**
 * The sample city: six fictional public-style repos and a usage reading.
 * Every README picture, every UI test shot and every capture comes from it,
 * so they all show the same city and never anyone's real or private repos.
 *
 *   npx tsx tools/sample.ts <dir>
 *
 * writes a complete PALIMPSEST_HOME at <dir>, marked as a sample home. Serve
 * it beside the installed engine with
 * PALIMPSEST_HOME=<dir> PALIMPSEST_PORT=4790 npm run engine. An engine on a
 * sample home answers every gh and git call from the sample stand-in and
 * keeps the usage hook's Claude settings inside <dir>, so it never reaches
 * GitHub or your own ~/.claude/settings.json. The repos have varied
 * ages and sizes, use all five roots, and include a stretch co-authored by
 * Claude and one empty repo. Floors are built by the engine's own
 * foundingFloors from generated commits and merged PRs, exactly as a real
 * connect builds them. The history is deterministic: the same names, dates
 * and subjects every run. Only the usage reading is stamped with the time it
 * is written, so it reads as fresh.
 *
 * tools/ui-test.ts and tools/capture.ts call seedSample() after setting
 * PALIMPSEST_HOME, and use sampleGh (engine/sample.ts) as a stand-in for
 * every gh and git call.
 */
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PR } from '../engine/github.js';
import type { Commit } from '../engine/mirror.js';
import type { SampleRepo } from '../engine/sample.js';
import { defaultHome } from '../engine/home.js';
import { SAMPLE, SAMPLE_MARKER } from '../engine/sample.js';
import type { Repo, TowerSpec } from '../shared/types.js';

export type { SampleRepo } from '../engine/sample.js';
export { SAMPLE, SAMPLE_OTHERS, SAMPLE_UNREADABLE, sampleGh } from '../engine/sample.js';

/** When the Claude co-authored stretch can begin in any repo. */
const CLAUDE_SINCE = Date.parse('2025-03-01T00:00:00Z');

/** When the sample repos were connected. */
const CONNECTED = Date.parse('2026-11-02T10:00:00Z');

// ---------------------------------------------------------------- generated history

/** A small seeded PRNG (mulberry32), so every run builds the same history. */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERBS = ['Add', 'Fix', 'Rework', 'Speed up', 'Split up', 'Document', 'Test', 'Tidy', 'Handle errors in', 'Cache', 'Simplify', 'Rename fields in'];

/** A repo's commits, oldest first, and the PRs merged along the way. */
export function sampleHistory(s: SampleRepo): { commits: Commit[]; prs: PR[] } {
  const r = rng(s.fullName);
  const t0 = Date.parse(s.since);
  const t1 = Date.parse(s.until);
  // Sorted uniform times cluster on their own: busy weeks and quiet months.
  const times = Array.from({ length: s.commits }, () => t0 + r() * (t1 - t0)).sort((a, b) => a - b);
  if (times.length) {
    times[0] = t0;
    times[times.length - 1] = t1;
  }
  const commits: Commit[] = [];
  const prs: PR[] = [];
  let prNumber = 1;
  times.forEach((at, i) => {
    const sha = Array.from({ length: 5 }, () => Math.floor(r() * 0x100000000).toString(16).padStart(8, '0')).join('');
    const subject = i === 0 ? 'Initial commit' : `${VERBS[Math.floor(r() * VERBS.length)]} ${s.topics[Math.floor(r() * s.topics.length)]}`;
    const claude = at >= CLAUDE_SINCE && r() < s.claudeShare;
    // Mostly small changes, a few large ones.
    const lines = Math.round(3 + Math.pow(r(), 3.2) * 700);
    commits.push({
      sha,
      at: new Date(at).toISOString(),
      author: s.authors[Math.floor(r() * s.authors.length)],
      subject,
      body: claude ? 'Co-Authored-By: Claude <noreply@anthropic.com>' : '',
      lines,
    });
    if (i > 0 && r() < s.prShare) {
      prNumber += 1 + Math.floor(r() * 3);
      prs.push({ number: prNumber, title: subject, mergedAt: new Date(at).toISOString(), mergeSha: sha, url: `https://github.com/${s.fullName}/pull/${prNumber}` });
    }
  });
  return { commits, prs };
}

/**
 * The same six fictional repos in the shape of a working developer's city:
 * four short towers of roughly 8 to 30 floors and two at the 120-floor cap.
 * For captures that judge the look at that mix (CAPTURE_CITY=tall); the
 * README and the UI test use SAMPLE.
 */
export const SAMPLE_TALL: SampleRepo[] = SAMPLE.map((s) => {
  const shape: Record<string, Partial<SampleRepo>> = {
    'tidewater/harbor-ledger': { commits: 1400, since: '2019-02-01T09:00:00Z' },
    'kestrel/fieldnotes': { commits: 28 },
    'lantern/assay-kit': { commits: 1500, since: '2021-05-01T09:00:00Z' },
    'ferro/quarry': { commits: 14 },
    'hoshi/kumo': { commits: 24 },
    'alder/blank-slate': { commits: 11, since: '2026-06-02T09:00:00Z', until: '2026-10-30T09:00:00Z', prShare: 0.3, claudeShare: 0.7, authors: ['Wren Alder'], topics: ['scaffold', 'config', 'first screen'] },
  };
  return { ...s, ...shape[s.fullName] };
});

// ---------------------------------------------------------------- seeding

/**
 * Writes the sample repos, their founding towers and a fresh usage reading
 * into the current PALIMPSEST_HOME. Call it after setting PALIMPSEST_HOME.
 */
export async function seedSample(now: number = Date.now(), repos: SampleRepo[] = SAMPLE): Promise<void> {
  const { openDb } = await import('../engine/db.js');
  const { paths } = await import('../engine/home.js');
  const { foundingFloors } = await import('../engine/history.js');
  const db = openDb();
  for (const s of repos) {
    const { commits, prs } = sampleHistory(s);
    const floors = foundingFloors(s.fullName, commits, prs);
    const at = new Date(CONNECTED + s.slot * 60_000).toISOString();
    const repo: Repo = {
      fullName: s.fullName,
      private: false,
      defaultBranch: 'main',
      language: s.language,
      description: s.description,
      connected: true,
      pushMode: false,
      root: s.root,
      slot: s.slot,
      status: 'ready',
      error: null,
      connectedAt: at,
      analyzedAt: at,
    };
    const tower: TowerSpec = {
      id: `${s.fullName}#founding`,
      repo: s.fullName,
      kind: 'founding',
      root: s.root,
      floors,
      datumIndex: floors.length,
    };
    db.prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(s.fullName, JSON.stringify(repo));
    db.prepare('INSERT OR REPLACE INTO towers (repo, json) VALUES (?, ?)').run(s.fullName, JSON.stringify(tower));
  }
  // A usage reading taken a few minutes ago, as the statusline hook writes it.
  const sec = Math.floor(now / 1000) - 8 * 60;
  const reading = { at: sec, rate_limits: { five_hour: { used_percentage: 34, resets_at: sec + 3 * 3600 + 1200 }, seven_day: { used_percentage: 21, resets_at: sec + 4 * 86400 + 5 * 3600 } } };
  writeFileSync(`${paths().usage}/readings.jsonl`, `${JSON.stringify(reading)}\n`);
}

// ---------------------------------------------------------------- command line

/**
 * `p` with every symlink resolved, as far up as the path exists (a folder
 * still to be made keeps its own name under its real parent), in lower case
 * because the Mac's disk ignores case.
 */
function canonical(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs)) return realpathSync.native(abs).toLowerCase();
  const parent = dirname(abs);
  if (parent === abs) return abs.toLowerCase();
  return join(canonical(parent), basename(abs).toLowerCase());
}

/** True when `dir` is the real data home, however it is spelled: through a symlink, a parent step or another letter case. */
export function isRealDataHome(dir: string, real: string = defaultHome()): boolean {
  return canonical(dir) === canonical(real);
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: npx tsx tools/sample.ts <dir>');
    process.exit(2);
  }
  const home = resolve(dir);
  if (isRealDataHome(home)) {
    console.error('refusing to write the sample over the real data home');
    process.exit(2);
  }
  mkdirSync(home, { recursive: true });
  process.env.PALIMPSEST_HOME = home;
  await seedSample();
  // The mark that makes an engine on this folder answer GitHub from the sample and keep the usage hook inside it.
  writeFileSync(join(home, SAMPLE_MARKER), `${JSON.stringify({ sample: true, written: new Date().toISOString() })}\n`);
  const { openDb } = await import('../engine/db.js');
  const towers = openDb().prepare('SELECT repo, json FROM towers ORDER BY repo').all() as { repo: string; json: string }[];
  for (const t of towers) {
    const floors = (JSON.parse(t.json) as TowerSpec).floors;
    console.log(`${t.repo}: ${floors.length} floors, ${floors.filter((f) => f.claude).length} with Claude`);
  }
  console.log(`wrote ${home}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
