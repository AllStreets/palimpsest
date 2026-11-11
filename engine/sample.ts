/**
 * The sample city's GitHub, for an engine that serves a sample home. The
 * fictional repos, the other repos gh can see, and a gh and git stand-in that
 * answers for them without the network. tools/sample.ts builds the sample
 * home from these and marks it with SAMPLE_MARKER; an engine whose home holds
 * that marker answers every gh and git call from sampleGh and keeps the usage
 * hook's Claude settings inside the sample home.
 */
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { RootStyle } from '../shared/types.js';
import { openDb } from './db.js';
import type { Spawned, Spawner } from './exec.js';
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

/** The sample's own Claude transcripts folder (empty): the budget reads it, never his ~/.claude/projects. */
export function sampleProjectsDir(dir: string = home()): string {
  return join(dir, 'claude-projects');
}

/** The sample's Codex home, with a fixture session for Settings (Task 19 reads it through PALIMPSEST_CODEX_HOME). */
export function sampleCodexHome(dir: string = home()): string {
  return join(dir, 'providers', 'codex');
}

/** The sample's Gemini home, with a fixture chat. */
export function sampleGeminiHome(dir: string = home()): string {
  return join(dir, 'providers', 'gemini');
}

/**
 * Points every reader of his other folders at the sample home's own: the
 * Claude transcripts the budget scans, and the Codex and Gemini homes
 * Settings reads. A variable already set (a test's temp folder) is kept.
 */
export function useSampleFolders(dir: string = home()): void {
  const set = (k: string, v: string) => {
    if (!process.env[k]) process.env[k] = v;
  };
  set('PALIMPSEST_CLAUDE_PROJECTS', sampleProjectsDir(dir));
  set('PALIMPSEST_CODEX_HOME', sampleCodexHome(dir));
  set('PALIMPSEST_GEMINI_HOME', sampleGeminiHome(dir));
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

/**
 * The root files of each sample repo's default branch, as check detection
 * (engine/guild/checks.ts) reads them: harbor-ledger is a Vite app with every
 * check, fieldnotes is a Swift app nothing is detected in, assay-kit has
 * tests but no build, quarry is a Rust crate and kumo a Go module. A repo
 * not listed here (blank-slate, the other repos) has an empty tree. Two of
 * them therefore get the harness proposal (ruling 23). Of the other repos,
 * tidepool-notes has a test and a build, so push mode can go on there.
 */
export const SAMPLE_TREES: Record<string, Record<string, string>> = {
  'tidewater/harbor-ledger': {
    'package.json': `${JSON.stringify(
      {
        name: 'harbor-ledger',
        private: true,
        scripts: { test: 'node --test', typecheck: 'tsc --noEmit', lint: 'eslint .', build: 'vite build' },
        devDependencies: { typescript: '^5.9.0', vite: '^8.0.0', eslint: '^9.0.0' },
      },
      null,
      2,
    )}\n`,
    'package-lock.json': '{}\n',
    'tsconfig.json': '{}\n',
    'index.html': '<!doctype html>\n<title>Harbor ledger</title>\n',
    'README.md': '# Harbor ledger\n',
  },
  'kestrel/fieldnotes': {
    'Package.swift': '// swift-tools-version:5.9\n',
    'README.md': '# Fieldnotes\n',
  },
  'lantern/assay-kit': {
    'pyproject.toml': '[project]\nname = "assay-kit"\n',
    'requirements.txt': 'pytest\n',
    'pytest.ini': '[pytest]\n',
    'README.md': '# Assay kit\n',
  },
  'ferro/quarry': {
    'Cargo.toml': '[package]\nname = "quarry"\n',
    'Cargo.lock': '',
    'README.md': '# Quarry\n',
  },
  // A notes site with a test and a build, so push mode can be switched on (ruling 23); the UI test does.
  'marlow/tidepool-notes': {
    'package.json': `${JSON.stringify({ name: 'tidepool-notes', private: true, scripts: { test: 'node --test', build: 'vite build' }, devDependencies: { vite: '^8.0.0' } }, null, 2)}\n`,
    'package-lock.json': '{}\n',
    'index.html': '<!doctype html>\n<title>Tidepool notes</title>\n',
    'README.md': '# Tidepool notes\n',
  },
  'hoshi/kumo': {
    'go.mod': 'module example.com/kumo\n',
    'go.sum': '',
    'README.md': '# Kumo\n',
  },
};

/** The repo a git call names by its mirror (`-C <mirrors>/<owner>__<name>.git`), or null. */
function mirrorRepo(args: string[]): string | null {
  const i = args.indexOf('-C');
  if (i < 0 || !args[i + 1]) return null;
  const m = /^(.+?)__(.+)\.git$/.exec(basename(args[i + 1]));
  return m ? `${m[1]}/${m[2]}` : null;
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
    if (cmd === 'git' && args.includes('ls-tree')) {
      const tree = SAMPLE_TREES[mirrorRepo(args) ?? ''] ?? {};
      return ok(Object.keys(tree).map((n) => `${n}\0`).join(''));
    }
    if (cmd === 'git' && args.includes('show')) {
      const tree = SAMPLE_TREES[mirrorRepo(args) ?? ''] ?? {};
      const name = (args[args.length - 1] ?? '').split(':').slice(1).join(':');
      return name in tree ? ok(tree[name]) : { stdout: '', stderr: `fatal: path '${name}' does not exist`, code: 128 };
    }
    if (cmd === 'git' && args.includes('log')) {
      const log = Array.from({ length: 18 }, (_, i) => {
        const sha = `9${i.toString(16).padStart(6, '0')}`.padEnd(40, 'b');
        const at = new Date(Date.parse('2025-09-01T10:00:00Z') + i * 40 * 3600_000).toISOString();
        return `${RS}${sha}${US}${at}${US}Ada${US}Tide note ${i + 1}${US}${US}\n\n${30 + i * 13}\t0\tnotes.md\n`;
      }).join('');
      return ok(log);
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') return ok('[]');
    const market = marketAnswer(cmd, args);
    if (market) return market;
    throw new Error(`sampleGh: unexpected command ${cmd} ${args.join(' ')}`);
  };
}

// ---------------------------------------------------------------- the sample market's GitHub (Task 21)

/** The Ollama models the sample Mac has installed: every seeded local agent resolves, plus the vision judge. */
export const SAMPLE_INSTALLED = ['qwen3-coder:30b-a3b-q4_K_M', 'gpt-oss:20b', 'qwen2.5-coder:7b-instruct', 'qwen3:1.7b', 'qwen2.5vl:7b'];

/** The GitHub login the sample stand-in is signed in as. */
export const SAMPLE_LOGIN = 'marlow';

export interface SampleIssue {
  repo: string;
  number: number;
  title: string;
  labels: string[];
  author: string;
  updatedAt: string;
  body: string;
}

/**
 * The eight open issues the sample repos carry a market label on, as their
 * maintainers wrote them. Three are on the harbour repo. Every one is
 * fictional; seedEconomy posts them through the real pollJobs.
 */
export const SAMPLE_ISSUES: SampleIssue[] = [
  {
    repo: 'tidewater/harbor-ledger',
    number: 214,
    title: 'Berth schedule puts arrivals after midnight UTC on the previous day',
    labels: ['palimpsest', 'bug'],
    author: 'ines-varga',
    updatedAt: '2026-11-08T08:12:00Z',
    body: [
      'Ships that arrive between 00:00 and 01:00 UTC show up in the previous day\'s column of the berth schedule. The harbour office works in Lisbon time, so the *Maren Dahl* (00:40 UTC on the 12th) sat under the 11th all last week and the night shift missed her.',
      '',
      'To see it: import `fixtures/arrivals-dst.csv` and open the schedule for 12 March.',
      '',
      'We bucket by `arrival.toISOString().slice(0, 10)` in `src/schedule/days.ts`. It should be the harbour\'s own day.',
      '',
      'Scope:',
      '- src/schedule/**',
      '- test/schedule/**',
      '',
      '- [ ] Arrivals land in the harbour\'s local day, not the UTC day',
      '- [ ] A test covers 00:00 to 01:00 UTC on both sides of the March clock change',
    ].join('\n'),
  },
  {
    repo: 'tidewater/harbor-ledger',
    number: 219,
    title: 'Manifest CSV export splits the consignee when the name has a comma',
    labels: ['palimpsest:low'],
    author: 'tomas-reyes',
    updatedAt: '2026-11-09T14:30:00Z',
    body: [
      '"Holt, Varga & Sons" comes out as two columns in the manifest export, and customs rejects the file. We write the rows by joining with commas in `src/manifest/csv.ts` and never quote anything.',
      '',
      'Please quote fields that hold a comma, a quote or a newline (RFC 4180), and keep the column order exactly as it is: customs maps by position.',
      '',
      'Scope: src/manifest/**, test/manifest/**',
      '',
      '- [ ] A consignee with a comma round-trips through export and import',
      '- [ ] Fields without special characters are written unquoted, as today',
    ].join('\n'),
  },
  {
    repo: 'tidewater/harbor-ledger',
    number: 221,
    title: 'Port fee invoice: add the pilotage line the auditors asked for',
    labels: ['palimpsest:high', 'invoices'],
    author: 'mira-holt',
    updatedAt: '2026-11-10T07:05:00Z',
    body: [
      'The auditors want pilotage shown as its own line on the port fee invoice, with the pilot\'s hours and the rate that applied, instead of being folded into "harbour dues". It has to match the tariff table in `src/fees/tariff.ts` to the cent, including the night supplement.',
      '',
      'Old invoices must render exactly as they did; only invoices issued after this change get the new line. There is a snapshot test per invoice template; please add one rather than updating the old ones.',
      '',
      'Scope:',
      '- src/fees/**',
      '- src/invoice/**',
      '- test/invoice/**',
      '',
      '- [ ] Pilotage appears as its own line with hours, rate and amount',
      '- [ ] Totals are unchanged for every invoice in test/fixtures/invoices',
      '- [ ] Invoices issued before the change render byte for byte as before',
    ].join('\n'),
  },
  {
    repo: 'hoshi/kumo',
    number: 57,
    title: 'Tile cache never evicts tiles older than the radar retention',
    labels: ['palimpsest'],
    author: 'aiko-hoshino',
    updatedAt: '2026-11-07T21:44:00Z',
    body: [
      'The radar keeps two hours of frames, but `cache/tiles.go` only evicts by count, so after a stormy week the cache holds thousands of tiles nobody can request any more. My Pi ran out of disk on Sunday.',
      '',
      'Evict by age as well (anything older than the retention in `config.RadarRetention`), and keep the count limit as a backstop.',
      '',
      'Scope: cache/**',
      '',
      '- [ ] Tiles older than the retention are evicted on the next write',
      '- [ ] The count limit still applies',
      '- [ ] go test ./... passes with -race',
    ].join('\n'),
  },
  {
    repo: 'hoshi/kumo',
    number: 61,
    title: 'Light rain is unreadable on the dark dashboard',
    labels: ['palimpsest:low', 'ui'],
    author: 'sam-bell',
    updatedAt: '2026-11-09T19:02:00Z',
    body: [
      'The first two steps of the colour ramp (under 0.5 mm/h) are #1b2a3a and #1f3346, which is nearly the dashboard background. Drizzle just vanishes at night.',
      '',
      'Lift the low end of the ramp in `render/ramp.go` so it reads on #0e1620 without changing the heavy-rain colours people already know.',
      '',
      'Scope: render/**',
      '',
      '- [ ] The two lowest steps have at least 3:1 contrast against #0e1620',
      '- [ ] Steps from 4 mm/h up are unchanged',
    ].join('\n'),
  },
  {
    repo: 'lantern/assay-kit',
    number: 88,
    title: 'Custody chain export skips samples moved between freezers on the same day',
    labels: ['palimpsest:high', 'compliance'],
    author: 'clara-sousa',
    updatedAt: '2026-11-09T10:20:00Z',
    body: [
      'When a sample moves from F2 to F4 and back on the same day, the custody export in `assay/custody/export.py` keeps only the last move, because we key the transfers by (sample, date). The lab audit on the 20th needs every hand-off.',
      '',
      'Key transfers by their own id and order them by timestamp. The CSV header must not change.',
      '',
      'Scope:',
      '- assay/custody/**',
      '- tests/custody/**',
      '',
      '- [ ] Every transfer appears in the export, in time order',
      '- [ ] The CSV header is unchanged',
      '- [ ] A test covers two moves of one sample on one day',
    ].join('\n'),
  },
  {
    repo: 'ferro/quarry',
    number: 33,
    title: 'Typed rows: Option<T> columns panic on NULL from a LEFT JOIN',
    labels: ['palimpsest'],
    author: 'luca-ferro',
    updatedAt: '2026-11-08T16:50:00Z',
    body: [
      'A column declared `Option<i64>` panics with "invalid column type Null" when it comes from the right side of a LEFT JOIN, because `FromRow` asks the statement for the declared type and SQLite reports the left table\'s affinity.',
      '',
      'Decode `Option<T>` from the value, not the declared type. Minimal repro is in `tests/join_null.rs` (currently `#[ignore]`).',
      '',
      'Scope: src/row/**, tests/**',
      '',
      '- [ ] tests/join_null.rs passes without #[ignore]',
      '- [ ] No change to the public API',
    ].join('\n'),
  },
  {
    repo: 'kestrel/fieldnotes',
    number: 142,
    title: 'GPX import fails on Garmin files with extensions inside trkpt',
    labels: ['palimpsest:low'],
    author: 'ruth-ngata',
    updatedAt: '2026-11-06T09:15:00Z',
    body: [
      'Garmin watches write `<extensions><gpxtpx:TrackPointExtension>` inside each trkpt, and our parser in `Sources/Import/GPXParser.swift` treats any unknown child as an error. Every survey walked with a Forerunner fails to import.',
      '',
      'Skip unknown children of trkpt instead of failing; keep failing on a trkpt without lat or lon.',
      '',
      'Scope: Sources/Import/**, Tests/ImportTests/**',
      '',
      '- [ ] The Garmin file in Tests/ImportTests/Fixtures imports with all 412 points',
    ].join('\n'),
  },
];

/**
 * The pull requests the sample stand-in has opened or scripted, by
 * `owner/name#number`. A PR it has never heard of reads as open. The sample
 * economy scripts merges and closes here (merge(), close()); a fresh engine
 * process starts with every PR open.
 */
interface ScriptedPR {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
  closedAt: string | null;
  headRefOid: string | null;
  baseRefName: string;
}

const prBook = new Map<string, ScriptedPR>();
const prNext = new Map<string, number>();

/** The first PR number the stand-in hands out on each repo, above any number the sample history used. */
const FIRST_PR = 300;

export const samplePRs = {
  /** Marks a PR merged with the head the city pushed and a merge commit. */
  merge(repo: string, number: number, o: { headRefOid: string; mergeCommit: string; at?: string }): void {
    const at = o.at ?? new Date().toISOString();
    prBook.set(`${repo}#${number}`, { state: 'MERGED', mergedAt: at, mergeCommit: { oid: o.mergeCommit }, closedAt: at, headRefOid: o.headRefOid, baseRefName: 'main' });
  },
  /** Marks a PR closed without a merge. */
  close(repo: string, number: number, at: string = new Date().toISOString()): void {
    prBook.set(`${repo}#${number}`, { state: 'CLOSED', mergedAt: null, mergeCommit: null, closedAt: at, headRefOid: null, baseRefName: 'main' });
  },
  /** Forgets every scripted PR (tests). */
  reset(): void {
    prBook.clear();
    prNext.clear();
  },
};

/** The next PR number on `repo`: past every number the book and the stored runs already hold. */
function nextPR(repo: string): number {
  let top = prNext.get(repo) ?? FIRST_PR - 1;
  try {
    const row = openDb()
      .prepare("SELECT MAX(CAST(json_extract(json, '$.prNumber') AS INTEGER)) AS n FROM runs WHERE repo = ?")
      .get(repo) as { n: number | bigint | null } | undefined;
    top = Math.max(top, Number(row?.n ?? 0));
  } catch {
    // no database yet: the book alone decides
  }
  prNext.set(repo, top + 1);
  return top + 1;
}

function flag(args: string[], name: string): string | null {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1] ?? null;
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
}

/**
 * The market's gh calls (Tasks 5 and 16) and `ollama list`, answered from
 * the sample: issues per label, an issue's state, label and comment writes
 * (accepted and dropped), PR create and view from the scripted book, the
 * signed-in login. Null for anything else, so sampleGh throws on it.
 */
function marketAnswer(cmd: string, args: string[]): { stdout: string; stderr: string; code: number } | null {
  const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
  const keychain = sampleKeychain.answer(cmd, args);
  if (keychain) return keychain;
  if (cmd === 'ollama' && args[0] === 'list') {
    const rows = SAMPLE_INSTALLED.map((m, i) => `${m.padEnd(32)}${(0x5a17c0de + i).toString(16).slice(0, 12)}    ${[18, 13, 4.7, 1.4, 6][i] ?? 1} GB    3 weeks ago`);
    return ok(`NAME                            ID              SIZE      MODIFIED\n${rows.join('\n')}\n`);
  }
  if (cmd !== 'gh') return null;
  const repo = flag(args, '-R');
  if (args[0] === 'issue' && args[1] === 'list' && repo) {
    const label = flag(args, '--label');
    const rows = SAMPLE_ISSUES.filter((i) => i.repo === repo && (label === null || i.labels.includes(label))).map((i) => ({
      number: i.number,
      title: i.title,
      body: i.body,
      labels: i.labels.map((name) => ({ name })),
      url: `https://github.com/${i.repo}/issues/${i.number}`,
      author: { login: i.author },
      updatedAt: i.updatedAt,
    }));
    return ok(JSON.stringify(rows));
  }
  if (args[0] === 'issue' && args[1] === 'view' && repo) {
    const open = SAMPLE_ISSUES.some((i) => i.repo === repo && i.number === Number(args[2]));
    return ok(JSON.stringify({ state: open ? 'OPEN' : 'CLOSED' }));
  }
  if (args[0] === 'issue' && (args[1] === 'edit' || args[1] === 'comment')) return ok('');
  if (args[0] === 'label' && args[1] === 'list') return ok(JSON.stringify([{ name: 'palimpsest' }, { name: 'palimpsest:low' }, { name: 'palimpsest:high' }]));
  if (args[0] === 'label' && args[1] === 'create') return ok('');
  if (args[0] === 'pr' && args[1] === 'create' && repo) {
    const n = nextPR(repo);
    prBook.set(`${repo}#${n}`, { state: 'OPEN', mergedAt: null, mergeCommit: null, closedAt: null, headRefOid: null, baseRefName: flag(args, '--base') ?? 'main' });
    return ok(`https://github.com/${repo}/pull/${n}\n`);
  }
  if (args[0] === 'pr' && args[1] === 'view' && repo) {
    const pr = prBook.get(`${repo}#${Number(args[2])}`) ?? { state: 'OPEN', mergedAt: null, mergeCommit: null, closedAt: null, headRefOid: null, baseRefName: 'main' };
    return ok(JSON.stringify(pr));
  }
  if (args[0] === 'api' && args[1] === 'user') return ok(`${SAMPLE_LOGIN}\n`);
  return null;
}

// ---------------------------------------------------------------- the sample keychain

/** True for `security` however it is named (`/usr/bin/security` in anthropic-api.ts). */
function isSecurity(cmd: string): boolean {
  return basename(cmd) === 'security';
}

let heldKey: string | null = null;

/**
 * The keychain a sample engine and the UI test use: the API key Settings
 * stores is held in this process's memory and nowhere else. `security` never
 * runs, so no keychain on this Mac (his login keychain least of all) is read
 * or written. The runner side answers find and delete; the spawner side takes
 * the `security -i` add command from stdin, as anthropic-api.ts sends it.
 */
export const sampleKeychain = {
  /** A runner answer for a `security` call, or null for any other command. */
  answer(cmd: string, args: string[]): { stdout: string; stderr: string; code: number } | null {
    if (!isSecurity(cmd)) return null;
    // With -w security prints the secret; without it, only the item's attributes (never the key).
    if (args[0] === 'find-generic-password') {
      if (!heldKey) return { stdout: '', stderr: 'The specified item could not be found in the keychain.', code: 44 };
      return { stdout: args.includes('-w') ? `${heldKey}\n` : 'class: "genp"\nattributes:\n    "svce"<blob>="Palimpsest Anthropic API key"\n', stderr: '', code: 0 };
    }
    if (args[0] === 'delete-generic-password') {
      const had = heldKey !== null;
      heldKey = null;
      return had ? { stdout: '', stderr: '', code: 0 } : { stdout: '', stderr: 'The specified item could not be found in the keychain.', code: 44 };
    }
    return { stdout: '', stderr: `security ${args[0] ?? ''} is not answered in a sample engine`, code: 1 };
  },
  /** A `security -i` child: stores the key an add command carries, prints nothing. */
  spawn(args: string[], stdin: string | undefined): Spawned {
    const m = args[0] === '-i' ? /^add-generic-password .* -w "([^"\\]*)"/.exec(stdin ?? '') : null;
    if (m) heldKey = m[1];
    const done: Spawned['done'] = Promise.resolve(m ? { code: 0, signal: null } : { code: 1, signal: null });
    return { pid: null, lines: { [Symbol.asyncIterator]: async function* () {} }, kill: () => {}, done };
  },
  isSet(): boolean {
    return heldKey !== null;
  },
  /** Forgets the key (tests). */
  reset(): void {
    heldKey = null;
  },
};

/**
 * `next` with every `security` child answered by the sample keychain instead.
 * For the UI test's engine: its home has no sample marker, so it never enters
 * sample mode and keeps the real spawner; this wrapper is what stops a real
 * `security -i` from starting there.
 */
export function withSampleKeychain(next: Spawner): Spawner {
  return (cmd, args, opts) => (isSecurity(cmd) ? sampleKeychain.spawn(args, opts.stdin) : next(cmd, args, opts));
}

/**
 * The spawner a sample engine runs with: it starts nothing. Every child the
 * market would start (claude, a check, caffeinate) ends at once as not
 * started, so nothing in a sample engine runs on this Mac or reaches out.
 * A `security -i` child goes to the sample keychain.
 */
export const sampleSpawner: Spawner = (cmd, args = [], opts = {}) => {
  if (isSecurity(cmd)) return sampleKeychain.spawn(args, opts.stdin);
  const done: Spawned['done'] = Promise.resolve({ code: null, signal: null, error: `${cmd.split('/').pop()} is not started in a sample engine` });
  return {
    pid: null,
    lines: { [Symbol.asyncIterator]: async function* () {} },
    kill: () => {},
    done,
  };
};
