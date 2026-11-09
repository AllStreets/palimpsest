/**
 * The sample city: six fictional public-style repos and a usage reading.
 * Every README picture, every UI test shot and every capture comes from it,
 * so they all show the same city and never anyone's real or private repos.
 *
 *   npx tsx tools/sample.ts <dir>
 *
 * writes a complete PALIMPSEST_HOME at <dir>. Serve it beside the installed
 * engine with PALIMPSEST_HOME=<dir> PALIMPSEST_PORT=4790 npm run engine.
 * The repos have varied
 * ages and sizes, use all five roots, and include a stretch co-authored by
 * Claude and one empty repo. Floors are built by the engine's own
 * foundingFloors from generated commits and merged PRs, exactly as a real
 * connect builds them. The history is deterministic: the same names, dates
 * and subjects every run. Only the usage reading is stamped with the time it
 * is written, so it reads as fresh.
 *
 * tools/ui-test.ts and tools/capture.ts call seedSample() after setting
 * PALIMPSEST_HOME, and use sampleGh as a stand-in for every gh and git call.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { PR } from '../engine/github.js';
import type { Commit } from '../engine/mirror.js';
import type { Repo, RootStyle, TowerSpec } from '../shared/types.js';

export interface SampleRepo {
  fullName: string;
  description: string;
  language: string;
  root: RootStyle;
  slot: number;
  /** First and last commit, ISO dates. */
  since: string;
  until: string;
  commits: number;
  /** Share of commits that land as merged PRs. */
  prShare: number;
  /** Share of commits co-authored by Claude from CLAUDE_SINCE on. */
  claudeShare: number;
  authors: string[];
  /** What the repo's changes are about: subjects are built from these. */
  topics: string[];
}

/** When the Claude co-authored stretch can begin in any repo. */
const CLAUDE_SINCE = Date.parse('2025-03-01T00:00:00Z');

/**
 * The six connected repos, in slot order. The first is the oldest and
 * biggest; kestrel/fieldnotes stalled in 2025;
 * hoshi/kumo is young and mostly co-authored by Claude; alder/blank-slate
 * has no commits at all and stands as a root alone.
 */
export const SAMPLE: SampleRepo[] = [
  {
    fullName: 'tidewater/harbor-ledger',
    description: 'Berth schedules, manifests and port fees for a small harbour',
    language: 'TypeScript',
    root: 'beauxarts',
    slot: 0,
    since: '2017-04-11T09:00:00Z',
    until: '2026-10-28T17:00:00Z',
    commits: 92,
    prShare: 0.3,
    claudeShare: 0.35,
    authors: ['Ines Varga', 'Tomas Reyes', 'Hal Okafor', 'Mira Holt'],
    topics: ['berth schedule', 'manifest export', 'port fees', 'tide tables', 'pilot bookings', 'invoice PDF', 'harbour map', 'crew roster', 'customs forms', 'audit log', 'sync worker', 'search index'],
  },
  {
    fullName: 'kestrel/fieldnotes',
    description: 'A notebook for bird surveys that works offline',
    language: 'Swift',
    root: 'chicago',
    slot: 1,
    since: '2021-09-02T08:00:00Z',
    until: '2025-01-19T20:00:00Z',
    commits: 38,
    prShare: 0.15,
    claudeShare: 0,
    authors: ['Ruth Ngata', 'Owen Pike'],
    topics: ['survey form', 'species list', 'offline cache', 'map pins', 'GPX import', 'photo notes', 'export to CSV', 'tally counter'],
  },
  {
    fullName: 'lantern/assay-kit',
    description: 'Lab sample tracking with barcode labels and chain of custody',
    language: 'Python',
    root: 'gothic',
    slot: 2,
    since: '2020-02-17T10:00:00Z',
    until: '2026-10-30T15:00:00Z',
    commits: 66,
    prShare: 0.4,
    claudeShare: 0.6,
    authors: ['Dev Anand', 'Clara Sousa', 'Pim de Wit'],
    topics: ['barcode labels', 'custody chain', 'sample intake', 'freezer map', 'assay results', 'LIMS bridge', 'audit trail', 'label printer', 'batch import'],
  },
  {
    fullName: 'ferro/quarry',
    description: 'Query builder for SQLite with typed rows',
    language: 'Rust',
    root: 'roman',
    slot: 3,
    since: '2024-05-06T09:00:00Z',
    until: '2026-09-12T18:00:00Z',
    commits: 24,
    prShare: 0.5,
    claudeShare: 0.5,
    authors: ['Luca Ferro'],
    topics: ['join planner', 'typed rows', 'migrations', 'prepared statements', 'window functions', 'docs site', 'benchmarks'],
  },
  {
    fullName: 'hoshi/kumo',
    description: 'Weather radar tiles for a home dashboard',
    language: 'Go',
    root: 'pagoda',
    slot: 4,
    since: '2025-06-14T11:00:00Z',
    until: '2026-11-01T09:00:00Z',
    commits: 52,
    prShare: 0.2,
    claudeShare: 0.85,
    authors: ['Aiko Hoshino', 'Sam Bell'],
    topics: ['radar tiles', 'rain nowcast', 'tile cache', 'colour ramp', 'station feed', 'alerts', 'dashboard widget'],
  },
  {
    fullName: 'alder/blank-slate',
    description: 'A new project with nothing pushed yet',
    language: 'TypeScript',
    root: 'roman',
    slot: 5,
    since: '2026-10-20T09:00:00Z',
    until: '2026-10-20T09:00:00Z',
    commits: 0,
    prShare: 0,
    claudeShare: 0,
    authors: [],
    topics: [],
  },
];

/** Repos gh can see that are not in the city: the Repos screen's other rows. All fictional. */
export const SAMPLE_OTHERS = [
  { fullName: 'marlow/tidepool-notes', private: false, description: 'Field notes from the tide pools, kept as markdown', language: 'Markdown' },
  { fullName: 'marlow/locked-vault', private: true, description: 'Private records the CLI cannot read', language: 'Rust' },
  { fullName: 'orrery/brass-gears', private: true, description: 'Gear trains for a desk orrery', language: 'Python' },
  { fullName: 'orrery/star-catalogue', private: false, description: null, language: 'Go' },
  { fullName: 'quill/marginalia', private: false, description: 'Notes in the margins of old manuals', language: 'TypeScript' },
];

/** The one listed repo gh cannot read, so connecting it ends in a readable error. */
export const SAMPLE_UNREADABLE = 'marlow/locked-vault';

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

// ---------------------------------------------------------------- seeding

/**
 * Writes the sample repos, their founding towers and a fresh usage reading
 * into the current PALIMPSEST_HOME. Call it after setting PALIMPSEST_HOME.
 */
export async function seedSample(now: number = Date.now()): Promise<void> {
  const { openDb } = await import('../engine/db.js');
  const { paths } = await import('../engine/home.js');
  const { foundingFloors } = await import('../engine/history.js');
  const db = openDb();
  for (const s of SAMPLE) {
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

// ---------------------------------------------------------------- a fake GitHub

const RS = '\x1e';
const US = '\x1f';

/**
 * A gh and git stand-in that sees the sample repos and SAMPLE_OTHERS and
 * never touches the network. `delayMs` slows every call, so each step of an
 * analysis is visible. Connecting any repo reads an 18-commit history.
 */
export function sampleGh(delayMs = 0): (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string; code: number }> {
  const available = [
    ...SAMPLE.map((s) => ({ fullName: s.fullName, private: false, description: s.description, language: s.language })),
    ...SAMPLE_OTHERS,
  ];
  const row = (fullName: string) => {
    const a = available.find((x) => x.fullName === fullName);
    return {
      nameWithOwner: fullName,
      isPrivate: a?.private ?? false,
      description: a?.description ?? null,
      primaryLanguage: a?.language ? { name: a.language } : null,
      defaultBranchRef: { name: 'main' },
    };
  };
  const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
  return async (cmd, args) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (cmd === 'gh' && args[0] === 'auth') return ok('');
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'list') return ok(JSON.stringify(available.map((a) => row(a.fullName))));
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') {
      if (args[2] === SAMPLE_UNREADABLE) {
        return { stdout: '', stderr: `GraphQL: Could not resolve to a Repository with the name '${SAMPLE_UNREADABLE}'.`, code: 1 };
      }
      return ok(JSON.stringify(row(args[2])));
    }
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'clone') return ok('');
    if (cmd === 'git' && args.includes('log')) {
      const log = Array.from({ length: 18 }, (_, i) => {
        const sha = `9${i.toString(16).padStart(6, '0')}`.padEnd(40, 'b');
        const at = new Date(Date.parse('2025-09-01T10:00:00Z') + i * 40 * 3600_000).toISOString();
        return `${RS}${sha}${US}${at}${US}Ada${US}Tide note ${i + 1}${US}${US}\n\n${30 + i * 13}\t0\tnotes.md\n`;
      }).join('');
      return ok(log);
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return ok('[]');
    throw new Error(`sampleGh: unexpected command ${cmd} ${args.join(' ')}`);
  };
}

// ---------------------------------------------------------------- command line

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: npx tsx tools/sample.ts <dir>');
    process.exit(2);
  }
  const home = resolve(dir);
  if (home === resolve(homedir(), 'Library', 'Application Support', 'Palimpsest')) {
    console.error('refusing to write the sample over the real data home');
    process.exit(2);
  }
  mkdirSync(home, { recursive: true });
  process.env.PALIMPSEST_HOME = home;
  await seedSample();
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
