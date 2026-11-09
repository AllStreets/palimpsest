/**
 * The sample city's GitHub, for an engine that serves a sample home. The
 * fictional repos, the other repos gh can see, and a gh and git stand-in that
 * answers for them without the network. tools/sample.ts builds the sample
 * home from these and marks it with SAMPLE_MARKER; an engine whose home holds
 * that marker answers every gh and git call from sampleGh and keeps the usage
 * hook's Claude settings inside the sample home.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { RootStyle } from '../shared/types.js';
import { home } from './home.js';

/** The file tools/sample.ts writes into a sample home: its presence makes the engine a sample engine. */
export const SAMPLE_MARKER = 'sample.json';

/** True when `dir` (the data home by default) was written by tools/sample.ts. */
export function isSampleHome(dir: string = home()): boolean {
  return existsSync(join(dir, SAMPLE_MARKER));
}

/** The stand-in Claude settings file a sample engine's usage hook writes, inside the sample home. */
export function sampleClaudeSettingsPath(dir: string = home()): string {
  return join(dir, 'claude-settings.json');
}

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
