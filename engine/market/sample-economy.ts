/**
 * The sample economy (Task 21): a fictional, fully scripted market on the
 * sample city, so captures, the UI test and the README can show a living
 * economy without touching anything real. Nothing here calls a model, gh,
 * Ollama, the network or his folders: every gh and `ollama list` call goes
 * to the sample stand-in (engine/sample.ts), every money row is written by
 * the city's own budget and treasury, and every record is in the ledger, so
 * `verifyReplay()` holds on the result.
 *
 * seedEconomy(now) writes, on top of seedSample(), eight days of market
 * history ending at `now`: the five firms (seedFirms on the sample's
 * installed models) and a sixth, Lodestar, that overspent, went bankrupt and
 * whose dark tower Quickset bought and re-clad; one roster specialist hired
 * on the same daily tick (the story's prices and costs come from one fixed
 * seed, so the books at that tick are the same at any hour: only Quickset
 * is above the hiring line, by about 200 credits, and every other firm is
 * at least 75 below it); sixty-odd merged jobs whose floors stand on the
 * district towers and the agent towers; scars, a closed PR, a reverted merge
 * that halted a repo; and a board in every state at `now`. The history runs
 * through the market's own functions (posting, award, transition, floors,
 * the PR poll, the treasury ticks, the daily report) under a scripted clock,
 * so every timestamp falls where the story puts it.
 *
 * economyClock() then advances the board on demand: the running job is
 * inspected, shipped and merged, the inspecting one ships, the awarded one
 * starts, the waiting PR merges, and people ride home, each step with the
 * same `run.*`, `site.changed`, `floor.*` and `trip.*` events a real run
 * emits. At speed 20 a capture sees a crane rise, sparks, searchlights and a
 * cure in about forty seconds.
 *
 * Trips are stored with hand-written legs until the routing task (Task 33)
 * switches the seed and the clock to startTrip().
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { calibrated as calibrate, expectedValue, TIER_VALUE } from '../../shared/market-rules.js';
import { silhouetteFor } from '../../shared/silhouette.js';
import type {
  Agent,
  Bid,
  CheckName,
  CheckResult,
  Firm,
  FloorSize,
  Inspection,
  Job,
  ModelRef,
  ProviderUsage,
  Repo,
  RunLogLine,
  RunStage,
  SiteStage,
  SiteState,
  Tier,
  Trip,
  TripMode,
  TripReason,
  Run,
} from '../../shared/types.js';
import { openDb } from '../db.js';
import { emit } from '../events.js';
import { getRunner, realRunner, setRunner } from '../exec.js';
import { createPR } from '../github.js';
import { detectFrom } from '../guild/checks.js';
import { canPush, inspectionSummary } from '../guild/inspect.js';
import { paths } from '../home.js';
import { districtOrigin, quarterOrigin } from '../layout.js';
import { query, record } from '../ledger.js';
import { earnedFloors, getRepo, listRepos, nextSlot, updateEarnedFloor, updateRepoMarket } from '../repos.js';
import { SAMPLE, SAMPLE_INSTALLED, SAMPLE_ISSUES, sampleCodexHome, sampleGeminiHome, sampleGh, samplePRs, sampleProjectsDir, SAMPLE_TREES, useSampleFolders } from '../sample.js';
import { award, bidList, eligibleAgents, NO_SLOT, openBidding } from './bids.js';
import { getSettings } from '../settings.js';
import { charge } from './budget.js';
import { agent as storedAgent, AGENT_TOOLS, agentTowerId, firm, listAgents, listFirms, seedFirms } from './firms.js';
import { attachRun, dismissProposed, job as storedJob, listJobs, pollJobs, postManualJob, proposeHarnessJob, settleJobEffects, transition } from './jobs.js';
import { reputation } from './reputation.js';
import { localDay, writeDailyReport } from './report.js';
import { haltRepo, listRuns, run as storedRun } from './runs.js';
import { agentFloorId, layJobFloors, layScar, pollPRs, repoFloorId, repoTowerId, resetShipping } from './ship.js';
import { bankruptcyTick, dailyTick, installTreasury, sellDarkTowers, settle } from './treasury.js';

export { SAMPLE_INSTALLED } from '../sample.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Weighted tokens per credit at the default calibration (60,000 tokens per percent, 0.1% per credit). */
const TOKENS_PER_CREDIT = 6_000;

const iso = (ms: number = Date.now()) => new Date(ms).toISOString();
const sha = (seed: string) => createHash('sha1').update(seed).digest('hex');
const round2 = (x: number) => Math.round(x * 100) / 100;

const TIER_SIZE: Record<Tier, FloorSize> = { low: 'small', normal: 'medium', high: 'large' };
const SITE_OF: Record<RunStage, SiteStage> = {
  preparing: 'crane',
  installing: 'crane',
  working: 'framing',
  inspecting: 'inspecting',
  shipping: 'curing',
  waiting: 'waiting',
  done: 'teardown',
};
const LIVE_STAGES: RunStage[] = ['preparing', 'installing', 'working', 'inspecting', 'shipping'];

// ---------------------------------------------------------------- the scripted clock

/**
 * While the history is written, `Date` reads the story's time rather than
 * the wall's, so every record, row and file the market writes lands where
 * the story puts it. Restored before seedEconomy returns, whatever happens.
 */
function scriptTime(start: number): { set(ms: number): void; restore(): void } {
  const Real = Date;
  let t = start;
  const Scripted = function (this: unknown, ...args: unknown[]) {
    if (!new.target) return new Real(t).toString();
    return Reflect.construct(Real, args.length ? args : [t], new.target);
  } as unknown as DateConstructor;
  Object.setPrototypeOf(Scripted, Real);
  (Scripted as { prototype: Date }).prototype = Real.prototype;
  (Scripted as { now: () => number }).now = () => t;
  globalThis.Date = Scripted;
  return {
    set: (ms) => {
      t = ms;
    },
    restore: () => {
      globalThis.Date = Real;
    },
  };
}

/** A small seeded PRNG (mulberry32), so the same `now` writes the same story. */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- the cast

const REPO = {
  H: 'tidewater/harbor-ledger',
  A: 'lantern/assay-kit',
  K: 'hoshi/kumo',
  Q: 'ferro/quarry',
  F: 'kestrel/fieldnotes',
} as const;
type RepoKey = keyof typeof REPO;
const MARKET_REPOS = Object.values(REPO);

/** The sixth firm: it priced every big job and promised everything; it ran out of money in three days. */
const LODESTAR: Firm = {
  id: 'lodestar',
  name: 'Lodestar',
  root: 'beauxarts',
  motto: 'Any job, any size, this week.',
  slot: 0,
  balance: 300,
  status: 'active',
  negativeSince: null,
  bankruptAt: null,
  createdAt: '',
};

const CORIN_PERSONA = `# Corin Hale

## Who I am

I founded Lodestar on the idea that most estimates are padded. I take the large jobs other firms walk away from and I price them as if nothing will go wrong.

## How I work

I read the issue, find the module it names and rewrite it the way I would have written it. I trust my own reading of the code over its tests, and I say so in my bid.

## What I will not do without asking

Never without asking: delete a repo, force-push, rewrite history, change repo settings, secrets or visibility, touch billing, delete branches the city did not create.

## How I report

I end every answer with one JSON block and nothing after it.
`;

function lodestarAgent(at: string): Agent {
  const temperament = 'bold generalists';
  return {
    id: 'corin-hale',
    firmId: LODESTAR.id,
    name: 'Corin Hale',
    model: 'claude:opus',
    persona: 'Prices the big jobs nobody else will touch, and says yes before reading the tests.',
    temperament,
    instructions: CORIN_PERSONA,
    tools: [...AGENT_TOOLS],
    workflow: { shape: 'single' },
    memory: { examples: 2 },
    lineage: { origin: 'seeded', parents: [], generation: 0, at },
    silhouette: silhouetteFor(temperament),
    maxTurns: 60,
    capability: 'scifi',
    bidsOn: ['low', 'normal', 'high'],
    retired: false,
    retiredReason: null,
    towerIndex: 0,
  };
}

/** How each firm prices and how sure it says it is, as fractions of the job's value. */
const STYLE: Record<string, { price: [number, number]; confidence: [number, number]; plans: string[] }> = {
  'ashlar-vane': {
    price: [0.38, 0.46],
    confidence: [0.74, 0.86],
    plans: [
      'Read {file} and the tests beside it before changing anything. Write a test that fails on {what}, then make the smallest change that passes it. Run the whole suite and every check the repo has, and read the diff once more against the issue before handing it in.',
      'Reproduce {what} first and keep the steps for the PR. Fix it where the fault is, not where it shows. Add a regression test in {test}, run every check, and ask for review with the reproduction attached.',
    ],
  },
  quickset: {
    price: [0.46, 0.58],
    confidence: [0.7, 0.82],
    plans: [
      'Find where {what} happens in {file}, fix it in place and add one test in {test}. Run the suite, done the same hour.',
      'Small change in {file}, written in the file\'s own style, one test that covers it, the suite before I say done.',
    ],
  },
  meridian: {
    price: [0.62, 0.72],
    confidence: [0.82, 0.9],
    plans: [
      'Plan first: map every caller of {file}, then decide where {what} should be fixed so none of them change behaviour by accident. Implement with tests for each caller that matters, run the full suite, and note in the PR what I deliberately left alone.',
    ],
  },
  kiln: {
    price: [0.22, 0.3],
    confidence: [0.62, 0.74],
    plans: [
      'Outline the change to {file} before writing it, then work through it in order: code, test in {test}, the full suite. Slow but every step checked.',
      'Read {file} end to end, write down the plan, then change it and add tests for {what}. Run the checks twice.',
    ],
  },
  sparrow: {
    price: [0.36, 0.5],
    confidence: [0.64, 0.76],
    plans: [
      'One small change in {file} and a test in {test}. Run the tests. Nothing else touched.',
      'Fix {what} with the least code that does it, then run the tests.',
    ],
  },
  lodestar: {
    price: [0.42, 0.5],
    confidence: [0.88, 0.95],
    plans: [
      'Rework {file} properly rather than patching it: the module has outgrown its design. {what} goes away with the rewrite. Tests updated to match.',
      'Replace the current approach in {file} with a cleaner one; {what} is a symptom. I will update whatever tests disagree.',
    ],
  },
};

/** What a call costs on each model, in credits: a bid's plan call, and a run (a range). */
function modelCost(model: ModelRef): { bid: number; run: [number, number] } {
  if (model.startsWith('claude:opus')) return { bid: 7, run: [38, 62] };
  if (model.startsWith('claude:sonnet')) return { bid: 3.4, run: [12, 24] };
  if (model.startsWith('claude:haiku')) return { bid: 1.2, run: [4, 9] };
  // Local: about an hour on a large model at seconds * (0.001 + 0.0001 * GB) (ruling 1).
  return { bid: 0.4, run: [9, 16] };
}

/** A workflow that checks itself or plans first spends more on each run. */
const WORKFLOW_COST: Record<string, number> = { single: 1, vote: 1, 'plan-then-answer': 1.15, 'self-check': 1.4 };

/** Minutes of work per run on each model. */
function workMinutes(model: ModelRef): [number, number] {
  if (model.startsWith('claude:opus')) return [30, 55];
  if (model.startsWith('claude:sonnet')) return [20, 40];
  if (model.startsWith('claude:haiku')) return [12, 24];
  return [35, 65];
}

/** Plausible files on each repo: a source file and where its test lives. */
const FILES: Record<RepoKey, string[]> = {
  H: ['src/schedule/days.ts', 'src/manifest/csv.ts', 'src/fees/tariff.ts', 'src/invoice/pdf.ts', 'src/pilots/bookings.ts', 'src/crew/roster.ts', 'src/sync/worker.ts', 'src/search/index.ts', 'src/map/berths.ts', 'src/customs/forms.ts', 'src/tides/tables.ts', 'src/audit/log.ts', 'docs/fees.md'],
  A: ['assay/custody/export.py', 'assay/intake/lots.py', 'assay/freezer/map.py', 'assay/labels/printer.py', 'assay/lims/bridge.py', 'assay/results/units.py', 'assay/audit/trail.py', 'assay/batch/import_csv.py', 'assay/search/plates.py'],
  K: ['cache/tiles.go', 'render/ramp.go', 'feed/station.go', 'alerts/alerts.go', 'nowcast/extrapolate.go', 'server/health.go', 'dashboard/widget.go', 'radar/tiles.go'],
  Q: ['src/row/from_row.rs', 'src/planner/join.rs', 'src/migrate/mod.rs', 'src/stmt/cache.rs', 'src/build/window.rs', 'benches/insert.rs', 'src/build/quote.rs', 'docs/planner.md'],
  F: ['Sources/Import/GPXParser.swift', 'Sources/Survey/Form.swift', 'Sources/Species/Search.swift', 'Sources/Export/CSV.swift', 'Sources/Tally/Counter.swift', 'Sources/Photos/Notes.swift', 'Sources/Map/Pins.swift'],
};

function testFor(file: string): string {
  if (file.endsWith('.md')) return file;
  if (file.endsWith('.go')) return file.replace(/\.go$/, '_test.go');
  if (file.endsWith('.py')) return file.replace(/^assay\/(\w+)\/(\w+)\.py$/, 'tests/$1/test_$2.py');
  if (file.endsWith('.rs')) return `tests/${file.split('/').pop()!.replace(/\.rs$/, '')}.rs`;
  if (file.endsWith('.swift')) return file.replace(/^Sources\/(\w+)\/(\w+)\.swift$/, 'Tests/$1Tests/$2Tests.swift');
  return file.replace(/^src\//, 'test/').replace(/\.ts$/, '.test.ts');
}

/** The source file a title is most likely about: the one whose path shares the most words with it. */
function fileFor(key: RepoKey, title: string, r: () => number): string {
  const words = new Set(title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  let best: string[] = [];
  let bestScore = -1;
  for (const f of FILES[key]) {
    const score = f.toLowerCase().split(/[^a-z0-9]+/).filter((w) => words.has(w) || words.has(`${w}s`) || words.has(w.replace(/s$/, ''))).length;
    if (score > bestScore) {
      best = [f];
      bestScore = score;
    } else if (score === bestScore) best.push(f);
  }
  return best[Math.floor(r() * best.length)];
}

// ---------------------------------------------------------------- the history

type Attempt = { agent: string; end: 'merged' | 'failed' | 'closed' };
interface Story {
  /** Days after the firms were seeded (eight days before `now`). */
  day: number;
  repo: RepoKey;
  tier: Tier;
  title: string;
  by: Attempt[];
  /** A day his revert of the merge landed on the default branch. */
  revertDay?: number;
}

/** The four jobs on the board when the daily tick sells Lodestar's tower and Quickset hires. */
const BOARD_DAY = 5.998;

const m = (agent: string): Attempt => ({ agent, end: 'merged' });
const f = (agent: string): Attempt => ({ agent, end: 'failed' });
const c = (agent: string): Attempt => ({ agent, end: 'closed' });

/**
 * Eight days of jobs, in the order they were posted. Lodestar's four merges
 * come first, then its five failures (each picked up again by another firm),
 * which take it below zero; it is bankrupt 72 hours later and its tower is
 * sold on day 6, when four jobs are on the board and Quickset alone can
 * afford to hire. Days 6.0 to 6.003 are that board.
 */
const HISTORY: Story[] = [
  { day: 0.2, repo: 'H', tier: 'normal', title: 'Customs forms: prefill the IMO number from the vessel record', by: [m('priya-rao')] },
  { day: 0.25, repo: 'A', tier: 'high', title: 'LIMS bridge times out on batches over 500 samples', by: [m('corin-hale')] },
  { day: 0.3, repo: 'K', tier: 'low', title: 'Add a /healthz endpoint for the Pi watchdog', by: [m('wren-sparrow')] },
  { day: 0.4, repo: 'H', tier: 'normal', title: "Pilot booking form loses the pilot's phone number on save", by: [m('ines-ashlar')] },
  { day: 0.5, repo: 'H', tier: 'low', title: 'Manifest export: add the gross tonnage column', by: [m('mack-quickset')] },
  { day: 0.6, repo: 'H', tier: 'normal', title: 'Audit log entries for fee overrides do not record who made them', by: [m('corin-hale')] },
  { day: 0.7, repo: 'Q', tier: 'normal', title: 'Migrations: run each file in its own transaction', by: [m('oskar-kiln')] },
  { day: 0.8, repo: 'H', tier: 'high', title: 'Sync worker retries forever after a 409 from the customs API', by: [m('ola-bergstrom')] },
  { day: 0.9, repo: 'K', tier: 'normal', title: 'Rain nowcast: extrapolate 30 minutes when the cells are small', by: [m('priya-rao')] },
  { day: 1.0, repo: 'F', tier: 'low', title: 'Species list search ignores accents', by: [m('wren-sparrow')] },
  { day: 1.05, repo: 'K', tier: 'high', title: 'Radar tiles: support the 512 px tile size', by: [m('corin-hale')] },
  { day: 1.1, repo: 'F', tier: 'low', title: 'Survey form: remember the last observer between sessions', by: [m('mack-quickset')] },
  { day: 1.2, repo: 'A', tier: 'high', title: 'Speed up the results search on the plate view', by: [m('ines-ashlar')] },
  { day: 1.3, repo: 'K', tier: 'normal', title: 'Station feed parser drops readings with no wind gust', by: [m('bruno-kiln')] },
  { day: 1.4, repo: 'Q', tier: 'normal', title: 'Window functions: support ROWS BETWEEN in the builder', by: [m('corin-hale')] },
  { day: 1.45, repo: 'H', tier: 'low', title: 'Document the fee override workflow in docs/fees.md', by: [m('juno-pike')] },
  { day: 1.5, repo: 'H', tier: 'normal', title: 'Berth map: show draught limits on hover', by: [m('priya-rao')] },
  { day: 1.6, repo: 'A', tier: 'low', title: 'Barcode labels print at 300 dpi on the 203 dpi printer', by: [m('mack-quickset')] },
  { day: 1.7, repo: 'H', tier: 'high', title: 'Search index rebuild blocks the API for 40 seconds', by: [f('corin-hale'), m('ines-ashlar')] },
  { day: 1.9, repo: 'A', tier: 'normal', title: 'Batch import: report every bad row, not just the first', by: [f('corin-hale'), m('priya-rao')] },
  { day: 2.0, repo: 'K', tier: 'low', title: 'Station list: sort stations by distance from home', by: [m('wren-sparrow')] },
  { day: 2.1, repo: 'K', tier: 'normal', title: 'Alerts fire twice when two stations cross the threshold together', by: [f('corin-hale'), m('ola-bergstrom')] },
  { day: 2.2, repo: 'A', tier: 'normal', title: 'Freezer map: show free slots per rack', by: [m('priya-rao')] },
  { day: 2.3, repo: 'Q', tier: 'high', title: 'Prepared statements leak when a query is dropped mid-iteration', by: [f('corin-hale'), m('hal-meridian')] },
  { day: 2.4, repo: 'H', tier: 'normal', title: 'Customs forms: validate the HS code against the 2027 schedule', by: [m('oskar-kiln')] },
  { day: 2.5, repo: 'F', tier: 'normal', title: 'Tally counter resets when the app goes to the background', by: [f('corin-hale'), m('teodor-vane')] },
  { day: 2.6, repo: 'H', tier: 'low', title: 'Crew roster CSV import ignores the rank column', by: [m('mack-quickset')] },
  { day: 2.7, repo: 'H', tier: 'low', title: 'Crew roster: sort by watch, then surname', by: [m('wren-sparrow')] },
  { day: 2.8, repo: 'A', tier: 'normal', title: 'Freezer map: flag racks warmer than -70 C', by: [m('teodor-vane')] },
  { day: 2.9, repo: 'H', tier: 'normal', title: 'Port fees: weekend surcharge applied on bank holidays too', by: [m('priya-rao')] },
  { day: 3.0, repo: 'K', tier: 'normal', title: 'Dashboard widget flickers on every tile refresh', by: [m('oskar-kiln')] },
  { day: 3.1, repo: 'Q', tier: 'normal', title: "Migrations: refuse to run when an applied file's checksum changed", by: [m('ines-ashlar')] },
  { day: 3.2, repo: 'A', tier: 'low', title: 'Sample intake rejects lot numbers with a slash', by: [m('wren-sparrow')] },
  { day: 3.3, repo: 'H', tier: 'high', title: 'Speed up the manifest search on large voyages', by: [m('hal-meridian')] },
  { day: 3.4, repo: 'K', tier: 'normal', title: 'Alerts: quiet hours from 23:00 to 07:00', by: [m('mack-quickset')] },
  { day: 3.5, repo: 'Q', tier: 'normal', title: 'Prepared statements: cache by SQL text, not by call site', by: [m('bruno-kiln')] },
  { day: 3.6, repo: 'A', tier: 'normal', title: 'Assay results: keep the units the instrument reported', by: [m('priya-rao')] },
  { day: 3.7, repo: 'A', tier: 'low', title: 'Add tests for the custody chain signatures', by: [m('juno-pike')] },
  { day: 3.8, repo: 'H', tier: 'low', title: 'Invoice PDF cuts off long vessel names', by: [m('wren-sparrow')] },
  { day: 3.9, repo: 'K', tier: 'normal', title: 'Tile cache: serve stale tiles while a refresh is in flight', by: [m('ola-bergstrom')] },
  { day: 4.0, repo: 'F', tier: 'normal', title: 'Photo notes: keep the EXIF location when a photo is attached', by: [m('teodor-vane')], revertDay: 6.8 },
  { day: 4.1, repo: 'Q', tier: 'normal', title: 'Typed rows: support chrono timestamps behind a feature flag', by: [m('oskar-kiln')] },
  { day: 4.2, repo: 'A', tier: 'normal', title: 'Audit trail: record who voided a result and why', by: [m('ines-ashlar')] },
  { day: 4.4, repo: 'H', tier: 'normal', title: 'Pilot bookings: warn when two pilots are booked for one tide', by: [m('priya-rao')] },
  { day: 4.5, repo: 'Q', tier: 'high', title: 'Join planner picks a full scan when an index covers the join', by: [c('hal-meridian')] },
  { day: 4.6, repo: 'H', tier: 'low', title: 'Lint: fix the no-floating-promises warnings in src/sync', by: [m('mack-quickset')] },
  { day: 4.8, repo: 'A', tier: 'normal', title: 'LIMS bridge: map the new result codes from the vendor', by: [m('bruno-kiln')] },
  { day: 4.9, repo: 'F', tier: 'low', title: 'Map pins: keep the pin colour per species', by: [m('wren-sparrow')] },
  { day: 5.0, repo: 'Q', tier: 'normal', title: 'Typed rows: derive FromRow for tuple structs', by: [m('priya-rao')] },
  { day: 5.1, repo: 'F', tier: 'low', title: 'Export to CSV: include the GPS accuracy column', by: [m('mack-quickset')] },
  { day: 5.2, repo: 'K', tier: 'low', title: 'Document the colour ramp in the README', by: [m('juno-pike')] },
  { day: 5.3, repo: 'H', tier: 'normal', title: 'Replace moment with Intl in the schedule view', by: [m('ines-ashlar')] },
  { day: 5.4, repo: 'A', tier: 'high', title: 'Batch import: stream large CSVs instead of loading them whole', by: [m('oskar-kiln')] },
  { day: 5.45, repo: 'K', tier: 'low', title: 'Station feed: drop readings stamped in the future', by: [f('wren-sparrow'), f('mack-quickset')] },
  { day: 5.6, repo: 'H', tier: 'low', title: 'Berth schedule print view drops the last row on A4', by: [m('priya-rao')] },
  { day: 5.9, repo: 'Q', tier: 'low', title: 'Docs: fix the broken links in the README badges', by: [m('wren-sparrow')] },
  // The board on the morning Lodestar's tower was sold (day 6): four jobs open at the daily tick.
  { day: BOARD_DAY, repo: 'Q', tier: 'normal', title: 'Docs site: the join planner page runs its examples against a stale schema', by: [m('ola-bergstrom')] },
  { day: BOARD_DAY, repo: 'K', tier: 'normal', title: 'Station feed: back off instead of retrying every second', by: [m('ines-ashlar')] },
  { day: BOARD_DAY, repo: 'H', tier: 'normal', title: 'Invoice numbering restarts at 1 when the year changes', by: [m('mack-quickset')] },
  { day: BOARD_DAY, repo: 'A', tier: 'normal', title: 'Label printer queue drops jobs when the printer wakes', by: [m('priya-rao')] },
  { day: 6.25, repo: 'H', tier: 'normal', title: 'Add tests for the tariff rounding rules', by: [m('dagny-hollis')] },
  { day: 6.5, repo: 'K', tier: 'normal', title: 'Colour ramp: read the palette from config instead of constants', by: [m('bruno-kiln')] },
  { day: 6.6, repo: 'Q', tier: 'low', title: 'Benchmarks: add a bench for 10k row inserts', by: [m('teodor-vane')] },
  { day: 6.7, repo: 'Q', tier: 'low', title: 'Add property tests for the identifier quoting', by: [m('dagny-hollis')] },
  { day: 6.9, repo: 'A', tier: 'high', title: "Chain of custody: sign each transfer with the operator's key", by: [m('hal-meridian')] },
  { day: 7.0, repo: 'H', tier: 'normal', title: 'Harbour map: berth labels overlap at low zoom', by: [m('ola-bergstrom')] },
  { day: 7.1, repo: 'Q', tier: 'normal', title: 'Query builder: quote identifiers that clash with SQL keywords', by: [m('oskar-kiln')] },
  { day: 7.2, repo: 'A', tier: 'low', title: 'Sample intake: trim spaces from pasted lot numbers', by: [m('mack-quickset')] },
  { day: 7.25, repo: 'A', tier: 'normal', title: 'Add tests for the freezer map slot counts', by: [m('dagny-hollis')] },
  { day: 7.3, repo: 'H', tier: 'normal', title: 'Tide tables cache misses on every request after midnight', by: [m('priya-rao')] },
];

/** The day a merge of Lodestar's was the last it would see. */
const HISTORY_DAYS = 8;

// ---------------------------------------------------------------- storage the market keeps private

function saveRun(r: Run): void {
  openDb().prepare('INSERT OR REPLACE INTO runs (id, job_id, repo, stage, json) VALUES (?, ?, ?, ?, ?)').run(r.id, r.jobId, r.repo, r.stage, JSON.stringify(r));
}

function saveBidRow(id: string, jobId: string, row: object): void {
  openDb().prepare('INSERT OR REPLACE INTO bids (id, job_id, json) VALUES (?, ?, ?)').run(id, jobId, JSON.stringify(row));
}

/** The bid a job was awarded to. */
function awardedBid(j: Job): Bid {
  const row = openDb().prepare('SELECT json FROM bids WHERE id = ?').get(j.awardedBid ?? '') as { json: string } | undefined;
  const bid = row ? (JSON.parse(row.json) as { bid?: Bid }).bid : undefined;
  if (!bid) throw new Error(`sample economy: ${j.title} has no awarded bid`);
  return bid;
}

function runRoot(runId: string): string {
  const dir = join(paths().runs, runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLog(runId: string, lines: RunLogLine[], live = false): void {
  const file = join(runRoot(runId), 'log.jsonl');
  appendFileSync(file, lines.map((l) => JSON.stringify(l) + '\n').join(''));
  if (live) for (const line of lines) emit('run.log', { runId, line });
}

function familyOf(model: ModelRef): string {
  return model.startsWith('ollama:') ? model.slice('ollama:'.length) : model.slice(model.indexOf(':') + 1);
}

/** A model call's usage that charge() turns into exactly `credits` at the default calibration. */
function usageOf(model: ModelRef, credits: number) {
  return model.startsWith('ollama:')
    ? { weightedTokens: 0, seconds: Math.round(credits / 0.002), usd: 0, credits }
    : { weightedTokens: Math.round(credits * TOKENS_PER_CREDIT), seconds: 0, usd: 0, credits };
}

// ---------------------------------------------------------------- one job, step by step

/** The market's own steps for one job, at whatever time the clock reads. */
class Pipeline {
  constructor(private readonly r: () => number) {}

  private pick<T>(xs: T[]): T {
    return xs[Math.floor(this.r() * xs.length)];
  }

  private between(lo: number, hi: number): number {
    return lo + this.r() * (hi - lo);
  }

  /** A plan in the firm's own voice. */
  plan(a: Agent, j: Job): string {
    const key = Object.keys(REPO).find((k) => REPO[k as RepoKey] === j.repo) as RepoKey | undefined;
    const file = j.scope.find((s) => !s.includes('*')) ?? (key ? fileFor(key, j.title, this.r) : j.scope[0] ?? 'the module');
    const what = j.title.charAt(0).toLowerCase() + j.title.slice(1).replace(/:/g, ',');
    return this.pick(STYLE[a.firmId]?.plans ?? STYLE.quickset.plans).replace(/\{file\}/g, file).replace(/\{test\}/g, testFor(file)).replace(/\{what\}/g, what);
  }

  /** One agent's bid, charged to its firm and recorded as bid.placed. */
  bid(j: Job, a: Agent, price: number, confidence: number, plan: string = this.plan(a, j)): Bid {
    const cost = modelCost(a.model).bid * (a.workflow.shape === 'vote' ? a.workflow.n ?? 3 : 1);
    const charged = charge({ runId: null, firmId: a.firmId, model: a.model, kind: 'bid', usage: usageOf(a.model, cost), unattended: false, at: Date.now(), minCredits: cost });
    const rep = reputation(a.firmId);
    const cal = calibrate(confidence, rep.overclaim);
    const bid: Bid = {
      id: `bid-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      jobId: j.id,
      firmId: a.firmId,
      agentId: a.id,
      plan,
      price,
      confidence,
      calibrated: cal,
      appraisal: rep.passRate[TIER_SIZE[j.tier]] ?? null,
      ev: expectedValue(cal, j.value, price),
      cost: charged,
      at: iso(),
    };
    saveBidRow(bid.id, j.id, { round: storedJob(j.id)?.bidsCloseAt, bid });
    record('bid.placed', { bid, calls: a.workflow.shape === 'vote' ? a.workflow.n ?? 3 : 1, charged: { kind: 'bid', credits: charged, by: 'budget' } });
    emit('bid.placed', { bid });
    return bid;
  }

  /** An agent that could not bid this round (it costs nothing: no plan call finished). */
  satOut(j: Job, a: Agent, reason: string): void {
    const s = { jobId: j.id, agentId: a.id, firmId: a.firmId, reason, note: `sat out: ${reason}`, at: iso() };
    saveBidRow(`sat-${randomUUID().replace(/-/g, '').slice(0, 12)}`, j.id, { round: storedJob(j.id)?.bidsCloseAt, satOut: s });
    emit('bid.satOut', { satOut: s });
  }

  /** The firm's own price and confidence for a job, before the award's arithmetic. */
  quote(a: Agent, j: Job): { price: number; confidence: number } {
    const s = STYLE[a.firmId] ?? STYLE.quickset;
    return { price: round2(j.value * this.between(...s.price)), confidence: round2(this.between(...s.confidence)) };
  }

  /**
   * A round the story's `winner` wins: its bid has a positive expected value
   * and each rival's is lower (a rival over the line raises its price, as a
   * firm that wants the margin does). Rivals are other eligible agents.
   */
  round(j: Job, winner: Agent, rivals: Agent[], sitOut: Agent | null = null, plans: Record<string, string> = {}): Bid {
    const w = this.quote(winner, j);
    const wCal = calibrate(w.confidence, reputation(winner.firmId).overclaim);
    if (wCal * j.value - w.price < 0.12 * j.value) w.price = round2(Math.max(1, wCal * j.value - 0.12 * j.value));
    const wEv = expectedValue(wCal, j.value, w.price);
    const quotes = rivals.map((a) => {
      const q = this.quote(a, j);
      const cal = calibrate(q.confidence, reputation(a.firmId).overclaim);
      if (expectedValue(cal, j.value, q.price) >= wEv - 0.5) q.price = round2(Math.min(j.value, cal * j.value - wEv + 1 + this.r() * 3));
      if (expectedValue(cal, j.value, q.price) >= wEv - 0.5) q.confidence = round2(Math.max(0.3, q.confidence - 0.2));
      return { a, q };
    });
    let won: Bid | null = null;
    // Bids come in as the plan calls finish: the cheap local ones last.
    const order = [{ a: winner, q: w }, ...quotes].sort(() => this.r() - 0.5);
    for (const { a, q } of order) {
      const b = this.bid(j, a, q.price, q.confidence, plans[a.id]);
      if (a.id === winner.id) won = b;
    }
    if (sitOut) this.satOut(j, sitOut, NO_SLOT);
    return won!;
  }

  /** The award, by the market's own rule; the story's winner must come out on top. */
  award(j: Job, expected: Bid): Job {
    const close = Date.parse(storedJob(j.id)!.bidsCloseAt!);
    const chosen = award(storedJob(j.id)!, Math.max(Date.now(), close));
    if (chosen?.id !== expected.id) throw new Error(`sample economy: ${j.title} went to ${chosen?.agentId ?? 'nobody'}, not ${expected.agentId}`);
    return storedJob(j.id)!;
  }

  /** The run starts: preparing, as the runner begins one. */
  begin(j: Job, bid: Bid): Run {
    const a = storedAgent(bid.agentId)!;
    const id = `run-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const r: Run = {
      id,
      jobId: j.id,
      bidId: bid.id,
      agentId: a.id,
      firmId: a.firmId,
      repo: j.repo,
      model: a.model,
      branch: `palimpsest/${j.id}`,
      dir: null,
      baseSha: null,
      headSha: null,
      stage: 'preparing',
      outcome: null,
      endedReason: null,
      progress: { toolCalls: 0, filesChanged: 0, testsRun: 0, turns: 0, weightedTokens: 0, credits: 0, refusals: 0 },
      startedAt: iso(),
      endedAt: null,
      prNumber: null,
      prUrl: null,
      mergeSha: null,
      inspectionId: null,
      scar: false,
      unattended: new Date().getHours() >= 23 || new Date().getHours() < 7,
      summary: null,
    };
    attachRun(j.id, id);
    runRoot(id);
    saveRun(r);
    record('run.started', { runId: id, jobId: j.id, run: r });
    emit('run.started', { run: r });
    return this.stage(r, 'preparing');
  }

  stage(r: Run, stage: RunStage, patch: Partial<Run> = {}): Run {
    const next: Run = { ...r, ...patch, stage };
    saveRun(next);
    record('run.stage', { runId: r.id, jobId: r.jobId, stage, at: iso() });
    emit('run.stage', { runId: r.id, stage });
    return next;
  }

  /** The install stage's check, as the runner records it. */
  install(r: Run): Run {
    const repo = getRepo(r.repo)!;
    const next = this.stage(r, 'installing', { baseSha: sha(`${r.repo}@main@${r.startedAt}`) });
    if (repo.checks?.install) this.checkDone(next, { name: 'install', status: 'pass', detail: repo.checks.install, durationMs: Math.round(this.between(9, 40) * 1000), logPath: null, testsRun: null });
    return next;
  }

  working(r: Run): Run {
    transition(storedJob(r.jobId)!, 'running', { runId: r.id });
    return this.stage(r, 'working');
  }

  /** The agent stops: its run is charged, the engine commits and records the diff, the job goes to inspection. */
  finishWork(r: Run, o: { files: string[]; lines: number; credits: number; summary: string; patch?: string }): Run {
    const credits = charge({ runId: r.id, firmId: r.firmId, model: r.model, kind: 'run', usage: usageOf(r.model, o.credits), unattended: r.unattended, at: Date.now(), minCredits: o.credits });
    const turns = Math.round(this.between(8, 30));
    // A run the log already counted keeps its counts; the rest are what a run of its size does.
    const counted = r.progress.turns > 0;
    const progress = {
      toolCalls: counted ? r.progress.toolCalls : turns * 2 + Math.round(this.r() * 6),
      filesChanged: o.files.length,
      testsRun: counted ? r.progress.testsRun : Math.round(this.between(12, 320)),
      turns: counted ? r.progress.turns : turns,
      weightedTokens: r.model.startsWith('ollama:') ? 0 : Math.round(credits * TOKENS_PER_CREDIT),
      credits,
      refusals: r.progress.refusals,
    };
    const head = sha(`${r.id}@head`);
    const next: Run = { ...r, headSha: head, progress, summary: o.summary };
    saveRun(next);
    const patch = o.patch ?? o.files.map((file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n`).join('');
    const patchPath = join(runRoot(r.id), 'diff.patch');
    writeFileSync(patchPath, patch);
    record('run.diff', { runId: r.id, jobId: r.jobId, headSha: head, baseSha: r.baseSha, files: o.files, lines: o.lines, sha256: createHash('sha256').update(patch).digest('hex'), patchPath });
    transition(storedJob(r.jobId)!, 'inspecting');
    return this.stage(next, 'inspecting');
  }

  checkDone(r: Run, check: CheckResult): void {
    record('check.done', { runId: r.id, jobId: r.jobId, check });
    emit('check.done', { runId: r.id, check });
  }

  /** The repo's checks as one inspection runs them: every command it has, then scope and review. */
  checks(r: Run, failing: CheckName | null): CheckResult[] {
    const repo = getRepo(r.repo)!;
    const out: CheckResult[] = [];
    const ms = () => Math.round(this.between(4, 90) * 1000);
    for (const name of ['install', 'test', 'typecheck', 'lint', 'build'] as const) {
      const cmd = repo.checks?.[name] ?? null;
      if (!cmd) {
        if (name !== 'install') out.push({ name, status: 'skipped', detail: `No ${name} command: skipped, never counted as a pass.`, durationMs: 0, logPath: null, testsRun: null });
        continue;
      }
      const tests = name === 'test' ? r.progress.testsRun || Math.round(this.between(20, 300)) : null;
      if (failing === name) out.push({ name, status: 'fail', detail: `${cmd}: 2 of ${tests ?? 0} tests failed, both in the file the change touched`, durationMs: ms(), logPath: null, testsRun: tests });
      else out.push({ name, status: 'pass', detail: cmd, durationMs: ms(), logPath: null, testsRun: tests });
    }
    out.push({ name: 'scope', status: 'pass', detail: 'Every changed file is inside the job\'s scope.', durationMs: 3, logPath: null, testsRun: null });
    return out;
  }

  /** Another firm's reviewer reads the change; the inspection is recorded as the guild records it. */
  inspect(r: Run, o: { passed: boolean; reviewer: Agent; failing?: CheckName | null; concerns?: string[] }): Inspection {
    const checks = this.checks(r, o.failing ?? null);
    const failedCheck = checks.some((x) => x.status === 'fail');
    const reviewCost = round2(modelCost(o.reviewer.model).bid * 1.5);
    // The review call is skipped once a check has failed: the verdict is already decided (Task 15).
    if (!failedCheck) {
      charge({ runId: r.id, firmId: null, model: o.reviewer.model, kind: 'review', usage: usageOf(o.reviewer.model, reviewCost), unattended: r.unattended, at: Date.now(), minCredits: reviewCost });
      const approve = o.passed;
      checks.push({
        name: 'review',
        status: approve ? 'pass' : 'fail',
        detail: approve ? `${o.reviewer.name}: reads right; the test covers the case in the issue.` : `${o.reviewer.name}: ${(o.concerns ?? ['the change rewrites far more than the issue asks for, and two existing tests were edited to pass']).join('; ')}`,
        durationMs: Math.round(this.between(40, 160) * 1000),
        logPath: null,
        testsRun: null,
      });
    }
    const recorded = new Set(query({ kind: 'check.done', runId: r.id }).map((e) => (e.data as { check: CheckResult }).check.name));
    for (const check of checks) if (!recorded.has(check.name)) this.checkDone(r, check);
    const passed = o.passed && !failedCheck;
    const i: Inspection = {
      id: `insp-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      runId: r.id,
      jobId: r.jobId,
      repo: r.repo,
      reviewerAgentId: failedCheck ? null : o.reviewer.id,
      reviewerFirmId: failedCheck ? null : o.reviewer.firmId,
      checks,
      passed,
      pushable: passed && canPush(checks),
      design: null,
      cost: failedCheck ? 0 : reviewCost,
      at: iso(),
      inconclusive: null,
    };
    openDb().prepare('INSERT OR REPLACE INTO inspections (id, run_id, json) VALUES (?, ?, ?)').run(i.id, r.id, JSON.stringify(i));
    const j = storedJob(r.jobId)!;
    record('inspection.done', {
      inspectionId: i.id,
      runId: r.id,
      jobId: r.jobId,
      repo: r.repo,
      value: j.value,
      reviewerAgentId: i.reviewerAgentId,
      reviewerFirmId: i.reviewerFirmId,
      passed: i.passed,
      pushable: i.pushable,
      inconclusive: null,
      summary: inspectionSummary(i),
      inspection: i,
    });
    emit('inspection.done', { inspection: i });
    const strikes = passed ? 0 : (getRepo(r.repo)?.strikes ?? 0) + 1;
    if (strikes >= 3) throw new Error(`sample economy: a third failed inspection in a row on ${r.repo}`);
    updateRepoMarket(r.repo, { strikes });
    return i;
  }

  /** A failed inspection: the scar on the job site, the run ends failed, the job returns once (ruling 16). */
  fail(r0: Run, i: Inspection, lines: number): Run {
    const r: Run = { ...r0, inspectionId: i.id };
    saveRun(r);
    layScar(r, storedJob(r.jobId)!, lines);
    const ended: Run = { ...r, outcome: 'failed', endedReason: 'The change failed inspection.', endedAt: iso(), stage: 'done', scar: true };
    saveRun(ended);
    record('run.ended', { runId: r.id, jobId: r.jobId, outcome: 'failed', reason: ended.endedReason, summary: ended.summary, run: ended });
    emit('run.ended', { runId: r.id, outcome: 'failed', reason: ended.endedReason });
    const cur = storedJob(r.jobId)!;
    const failed = transition(cur, 'failed', { excludedFirms: [...cur.excludedFirms, r.firmId] }, { summary: inspectionSummary(i) });
    if (failed.attempts < 2) transition(failed, 'open', { runId: null, awardedBid: null, bidsCloseAt: null });
    return ended;
  }

  /** A passed inspection ships as a PR: the city's waiting floors go up on both towers. */
  async ship(r0: Run, i: Inspection, lines: number): Promise<Run> {
    let r: Run = { ...r0, inspectionId: i.id };
    saveRun(r);
    const j = transition(storedJob(r.jobId)!, 'shipping');
    r = this.stage(r, 'shipping');
    const pr = await createPR(r.repo, { head: r.branch, base: 'main', title: j.title, body: `${inspectionSummary(i)}\n\nPalimpsest-Job: ${j.id}` });
    const at = iso();
    record('pr.opened', { runId: r.id, jobId: j.id, repo: r.repo, number: pr.number, url: pr.url, branch: r.branch, headSha: r.headSha, at });
    const floor = layJobFloors(r, j, { kind: 'pr', refs: [`#${pr.number}`], url: pr.url, lines, state: 'waiting', at });
    transition(storedJob(j.id)!, 'waiting', { floorId: floor.id });
    return this.stage(r, 'waiting', { prNumber: pr.number, prUrl: pr.url });
  }

  /** He merges the PR; the market's own poll finds it, lights the floors and pays the firm. */
  async merge(r: Run): Promise<void> {
    samplePRs.merge(r.repo, r.prNumber!, { headRefOid: r.headSha!, mergeCommit: sha(`${r.id}@merge`), at: iso() });
    resetShipping();
    await pollPRs(Date.now());
  }

  /** He closes the PR without merging: the waiting floors come down, no scar, no pay. */
  async close(r: Run): Promise<void> {
    samplePRs.close(r.repo, r.prNumber!, iso());
    resetShipping();
    await pollPRs(Date.now());
  }
}

// ---------------------------------------------------------------- the event queue

interface Step {
  at: number;
  seq: number;
  run: () => void | Promise<void>;
}

class Queue {
  private steps: Step[] = [];
  private seq = 0;

  push(at: number, run: () => void | Promise<void>): void {
    this.steps.push({ at, seq: this.seq++, run });
  }

  /** Runs every step in time order (steps may push later steps), each at its own time. */
  async drain(time: { set(ms: number): void }, until = Infinity): Promise<void> {
    for (;;) {
      let best = -1;
      for (let i = 0; i < this.steps.length; i++) {
        const s = this.steps[i];
        if (s.at > until) continue;
        if (best < 0 || s.at < this.steps[best].at || (s.at === this.steps[best].at && s.seq < this.steps[best].seq)) best = i;
      }
      if (best < 0) return;
      const [s] = this.steps.splice(best, 1);
      time.set(s.at);
      await s.run();
    }
  }
}

// ---------------------------------------------------------------- copy for the board at `now`

/** The live run's log: sixty lines of Priya Rao on the berth schedule, two refusals and the egress she met among them. */
function priyaLog(jobId: string, base: string, startedAt: number): RunLogLine[] {
  const L: Array<[RunLogLine['kind'], string]> = [
    ['engine', `run started on palimpsest/${jobId} from main at ${base.slice(0, 7)}`],
    ['engine', '[preparing] cloned tidewater/harbor-ledger into the run'],
    ['egress', 'allowed registry.npmjs.org:443 (install)'],
    ['engine', '[installing] npm ci'],
    ['egress', 'allowed registry.npmjs.org:443 (install)'],
    ['engine', '[installing] added 412 packages in 21 s'],
    ['system', 'claude -p haiku: six tools, the palimpsest MCP server only, at most 30 turns'],
    ['assistant', "I'll start with the README and the package scripts, then the schedule code the issue names."],
    ['tool', 'read_file README.md'],
    ['tool', 'read_file package.json'],
    ['tool', 'glob src/schedule/**'],
    ['tool', 'read_file src/schedule/days.ts'],
    ['assistant', 'dayOf() slices the ISO string, so it always buckets by the UTC date. The harbour zone lives in src/config/harbour.ts.'],
    ['tool', 'grep "timeZone" src'],
    ['tool', 'read_file src/config/harbour.ts'],
    ['tool', 'read_file test/schedule/days.test.ts'],
    ['assistant', 'There is already a helper, localDate(zone, instant), in src/time/zones.ts. I will use it rather than add another.'],
    ['tool', 'read_file src/time/zones.ts'],
    ['tool', 'run npm test -- test/schedule'],
    ['tool', 'tests 18, pass 18, fail 0'],
    ['assistant', 'Writing the failing test first: an arrival at 00:40 UTC on 12 March belongs to the 12th in Lisbon.'],
    ['tool', 'edit_file test/schedule/days.test.ts'],
    ['tool', 'run npm test -- test/schedule'],
    ['tool', 'tests 20, pass 18, fail 2'],
    ['tool', 'edit_file src/schedule/days.ts'],
    ['tool', 'run npm test -- test/schedule'],
    ['tool', 'tests 20, pass 20, fail 0'],
    ['refused', 'run git push origin HEAD: refused by the guard. A run never pushes; the engine ships from its own clone.'],
    ['assistant', 'Understood, pushing is the engine\'s job. Carrying on with the clock change.'],
    ['assistant', 'Lisbon moves to summer time on 29 March, so a 00:30 UTC arrival on the 29th is 01:30 local. Adding that case.'],
    ['tool', 'edit_file test/schedule/days.test.ts'],
    ['tool', 'run npm test -- test/schedule'],
    ['tool', 'tests 22, pass 22, fail 0'],
    ['egress', 'refused fonts.googleapis.com:443: not on this run\'s list'],
    ['engine', 'the print preview asked for a web font; the request was refused and it fell back to system fonts'],
    ['tool', 'run npm run typecheck'],
    ['tool', 'tsc --noEmit: no errors'],
    ['tool', 'run npm run lint'],
    ['tool', 'eslint: 1 warning, src/schedule/days.ts:14 prefer-const'],
    ['tool', 'edit_file src/schedule/days.ts'],
    ['tool', 'run npm run lint'],
    ['tool', 'eslint: no problems'],
    ['refused', 'read_file ~/.npmrc: refused, outside the run'],
    ['assistant', 'I do not need the registry config; the install already ran. Moving on.'],
    ['tool', 'grep "dayOf(" src'],
    ['assistant', 'Two other callers: the invoice period and the pilot board. Both want the harbour day too, so the fix is right for them. Checking the pilot board tests.'],
    ['tool', 'read_file src/pilots/board.ts'],
    ['tool', 'run npm test -- test/pilots'],
    ['tool', 'tests 31, pass 31, fail 0'],
    ['egress', 'allowed api.anthropic.com:443'],
    ['tool', 'run npm test'],
    ['tool', 'tests 286, pass 286, fail 0 (41.2 s)'],
    ['assistant', 'The full suite passes. Checking that the fixture from the issue imports cleanly.'],
    ['tool', 'read_file fixtures/arrivals-dst.csv'],
    ['tool', 'run node scripts/import-arrivals.mjs fixtures/arrivals-dst.csv --dry-run'],
    ['tool', '63 arrivals, 4 between 00:00 and 01:00 UTC, all in the harbour day'],
    ['assistant', 'Updating the comment on dayOf() so the next reader knows why it takes a zone.'],
    ['tool', 'edit_file src/schedule/days.ts'],
    ['tool', 'run npm test -- test/schedule'],
    ['tool', 'tests 22, pass 22, fail 0'],
  ];
  const step = Math.floor((38 * MIN) / L.length);
  return L.map(([kind, text], i) => ({ at: iso(startedAt + i * step), kind, text }));
}

/** What the clock has her do before she stops: the build, a last read, her summary. */
const PRIYA_MORE: Array<[RunLogLine['kind'], string]> = [
  ['tool', 'run npm run build'],
  ['tool', 'vite build: 214 modules transformed in 2.1 s'],
  ['assistant', 'Reading my diff against both boxes in the issue.'],
  ['tool', 'run git diff --stat'],
  ['tool', '3 files changed, 41 insertions, 9 deletions'],
  ['result', 'Arrivals now land in the harbour\'s own day: dayOf() takes the zone and uses localDate(). Tests cover 00:00 to 01:00 UTC on both sides of the March clock change.'],
];

const PRIYA_PATCH = `diff --git a/src/schedule/days.ts b/src/schedule/days.ts
--- a/src/schedule/days.ts
+++ b/src/schedule/days.ts
@@ -1,9 +1,13 @@
-import type { Arrival } from './types.js';
+import { harbour } from '../config/harbour.js';
+import { localDate } from '../time/zones.js';
+import type { Arrival } from './types.js';

-/** The schedule column an arrival belongs to. */
-export function dayOf(arrival: Arrival): string {
-  return arrival.at.toISOString().slice(0, 10);
+/**
+ * The schedule column an arrival belongs to: the harbour's own calendar day,
+ * not the UTC one, so a 00:40 UTC arrival in Lisbon lands on its local date.
+ */
+export function dayOf(arrival: Arrival, zone: string = harbour.timeZone): string {
+  return localDate(zone, arrival.at);
 }
diff --git a/test/schedule/days.test.ts b/test/schedule/days.test.ts
--- a/test/schedule/days.test.ts
+++ b/test/schedule/days.test.ts
@@ -30,3 +30,21 @@ test('arrivals group by day', () => {
+
+test('an arrival just after midnight UTC stays on the harbour day', () => {
+  assert.equal(dayOf(arrival('2027-03-12T00:40:00Z')), '2027-03-12');
+});
+
+test('the clock change moves the harbour day, not the UTC one', () => {
+  assert.equal(dayOf(arrival('2027-03-28T00:30:00Z')), '2027-03-28');
+  assert.equal(dayOf(arrival('2027-03-29T00:30:00Z')), '2027-03-29');
+});
`;

const HAL_PATCH = `diff --git a/assay/custody/export.py b/assay/custody/export.py
--- a/assay/custody/export.py
+++ b/assay/custody/export.py
@@ -18,12 +18,10 @@ def custody_rows(transfers):
-    latest = {}
-    for t in transfers:
-        latest[(t.sample_id, t.at.date())] = t
-    return [row(t) for t in sorted(latest.values(), key=lambda t: t.at)]
+    # Every hand-off is evidence: key by the transfer itself, never by the day.
+    seen = {t.id: t for t in transfers}
+    return [row(t) for t in sorted(seen.values(), key=lambda t: (t.at, t.id))]
diff --git a/tests/custody/test_export.py b/tests/custody/test_export.py
--- a/tests/custody/test_export.py
+++ b/tests/custody/test_export.py
@@ -40,3 +40,14 @@ def test_header_is_stable():
+
+def test_two_moves_on_one_day_are_both_exported():
+    rows = custody_rows([move("S-118", "F2", "F4", "09:10"), move("S-118", "F4", "F2", "16:45")])
+    assert [r["to"] for r in rows] == ["F4", "F2"]
`;

const OLA_PATCH = `diff --git a/cache/tiles.go b/cache/tiles.go
--- a/cache/tiles.go
+++ b/cache/tiles.go
@@ -52,6 +52,14 @@ func (c *Cache) Put(key string, t Tile) {
 	c.items[key] = entry{tile: t, at: c.now()}
+	c.evictOlderThan(c.now().Add(-config.RadarRetention))
 	for len(c.items) > c.max {
 		c.evictOldest()
 	}
 }
+
+func (c *Cache) evictOlderThan(cutoff time.Time) {
+	for k, e := range c.items {
+		if e.at.Before(cutoff) {
+			delete(c.items, k)
+		}
+	}
+}
`;

/** A short log for a run in the history: what a working run's log reads like, without the noise. */
function shortLog(a: Agent, j: Job, files: string[], startedAt: number, endedAt: number, summary: string): RunLogLine[] {
  const repo = getRepo(j.repo);
  const test = repo?.checks?.test ?? 'the tests';
  const L: Array<[RunLogLine['kind'], string]> = [
    ['engine', `run started on palimpsest/${j.id}`],
    ['system', `${a.model.startsWith('ollama:') ? 'tool loop' : 'claude -p'} ${familyOf(a.model)}: six tools, at most ${a.maxTurns} turns`],
    ['assistant', `Reading ${files[0]} and its tests first.`],
    ['tool', `read_file ${files[0]}`],
    ['tool', `read_file ${files[1] ?? files[0]}`],
    ['tool', `edit_file ${files[1] ?? files[0]}`],
    ['tool', `edit_file ${files[0]}`],
    ['tool', `run ${test}`],
    ['tool', 'all tests pass'],
    ['result', summary],
  ];
  const step = Math.max(1, Math.floor((endedAt - startedAt) / L.length));
  return L.map(([kind, text], i) => ({ at: iso(startedAt + i * step), kind, text }));
}

// ---------------------------------------------------------------- trips

type P = { x: number; z: number };

function legOf(mode: TripMode, pts: P[], y = 0): Trip['legs'][number] {
  const speed: Record<TripMode, number> = { walk: 1.4, tram: 7, rail: 14, pod: 9, ferry: 5, cab: 11 };
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return { mode, path: pts.map((p) => [Math.round(p.x), y, Math.round(p.z)] as [number, number, number]), ms: Math.round((d / speed[mode]) * 1000) };
}

/** Where a firm's person stands at home: beside its tower in the quarter. */
function homeOf(a: Agent): P {
  const q = quarterOrigin(firm(a.firmId)?.slot ?? 0);
  return { x: q.x + (a.towerIndex % 2 ? 30 : -30), z: q.z + (a.towerIndex < 2 ? -30 : 30) };
}

function siteOf(repo: string): P {
  const r = getRepo(repo);
  const o = districtOrigin(r?.slot ?? 0);
  return { x: o.x + 40, z: o.z + 40 };
}

const EXCHANGE: P = { x: 0, z: 40 };
/** The river (ruling 14) runs north to south at x = -360. */
const RIVER_X = -360;

/** A trip's legs by its main mode, walking to and from the stop. */
function legsFor(mode: TripMode, from: P, to: P): Trip['legs'] {
  if (mode === 'walk') return [legOf('walk', [from, { x: to.x, z: from.z }, to])];
  if (mode === 'cab') return [legOf('cab', [from, { x: from.x, z: to.z }, to])];
  if (mode === 'ferry') {
    const on = { x: RIVER_X + 30, z: from.z };
    const off = { x: RIVER_X + 30, z: to.z };
    return [legOf('walk', [from, on]), legOf('ferry', [on, { x: RIVER_X, z: from.z }, { x: RIVER_X, z: to.z }, off]), legOf('walk', [off, to])];
  }
  const y = mode === 'rail' ? 12 : mode === 'pod' ? 6 : 0;
  const a = { x: from.x, z: from.z + 60 };
  const b = { x: to.x, z: from.z + 60 };
  return [legOf('walk', [from, a]), legOf(mode, [a, b, { x: to.x, z: to.z - 40 }], y), legOf('walk', [{ x: to.x, z: to.z - 40 }, to])];
}

function startTrip(a: Agent, reason: TripReason, jobId: string | null, mode: TripMode, from: P, to: P, startedAt: number, msScale = 1): Trip {
  const legs = legsFor(mode, from, to).map((l) => ({ ...l, ms: Math.max(1000, Math.round(l.ms * msScale)) }));
  const trip: Trip = {
    id: `trip-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    agentId: a.id,
    firmId: a.firmId,
    reason,
    jobId,
    from,
    to,
    legs,
    startedAt: iso(startedAt),
    ms: legs.reduce((s, l) => s + l.ms, 0),
    endedAt: null,
  };
  openDb().prepare('INSERT OR REPLACE INTO trips (id, json) VALUES (?, ?)').run(trip.id, JSON.stringify(trip));
  record('trip.started', { tripId: trip.id, agentId: a.id, firmId: a.firmId, jobId, trip });
  emit('trip.started', { trip });
  return trip;
}

function endTrip(t: Trip, at: number): void {
  const ended: Trip = { ...t, endedAt: iso(at) };
  openDb().prepare('UPDATE trips SET json = ? WHERE id = ?').run(JSON.stringify(ended), t.id);
  const data = { tripId: t.id, agentId: t.agentId, firmId: t.firmId, reason: 'arrived', at: iso(at) };
  record('trip.ended', data);
  emit('trip.ended', data);
}

function liveTrips(): Trip[] {
  return (openDb().prepare('SELECT json FROM trips').all() as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Trip).filter((t) => !t.endedAt);
}

// ---------------------------------------------------------------- provider fixtures

/** A Codex session and a Gemini chat under the sample home, for Settings' provider list (Task 19). */
function writeProviderFixtures(now: number): void {
  const day = new Date(now);
  const dir = join(sampleCodexHome(), 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
  mkdirSync(dir, { recursive: true });
  const sec = Math.floor(now / 1000);
  const lines = [0, 1, 2, 3].map((i) =>
    JSON.stringify({
      timestamp: iso(now - (90 - i * 25) * MIN),
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { total_tokens: 41_200 + i * 18_350 } },
        rate_limits: {
          primary: { used_percent: 12 + i * 4, window_minutes: 300, resets_at: sec + 2 * 3600 + 900 },
          secondary: { used_percent: 37 + i, window_minutes: 10080, resets_at: sec + 3 * 86400 + 4 * 3600 },
        },
      },
    }),
  );
  const file = join(dir, 'rollout-sample-harbour-notes.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  const at = new Date(now - 15 * MIN);
  utimesSync(file, at, at);

  const chats = join(sampleGeminiHome(), 'tmp', 'b7e1c2', 'chats');
  mkdirSync(chats, { recursive: true });
  const chat = join(chats, 'session-sample.json');
  writeFileSync(chat, JSON.stringify({ messages: [0, 1, 2].map((i) => ({ timestamp: iso(now - (300 - i * 60) * MIN), tokens: { total: 5_400 + i * 2_100 } })) }, null, 2));
  utimesSync(chat, at, at);
  mkdirSync(sampleProjectsDir(), { recursive: true });
}

// ---------------------------------------------------------------- the seed

/**
 * Writes the sample economy into the current PALIMPSEST_HOME, on top of
 * seedSample(): eight days of history ending at `now` and a board in every
 * state. gh and `ollama list` go to the sample stand-in unless a test has
 * installed its own runner.
 */
export async function seedEconomy(now: number = Date.now(), opts: { holdSale?: boolean } = {}): Promise<void> {
  for (const s of SAMPLE) if (!getRepo(s.fullName)) throw new Error(`seedEconomy runs on top of seedSample(): ${s.fullName} is missing`);
  useSampleFolders();
  mkdirSync(sampleProjectsDir(), { recursive: true });
  const own = getRunner() === realRunner;
  if (own) setRunner(sampleGh());
  const start = now - HISTORY_DAYS * DAY;
  const time = scriptTime(start);
  let offTreasury: () => void = () => {};
  try {
    offTreasury = installTreasury({ now: () => Date.now() });
    await writeHistory(now, start, time, opts.holdSale === true);
    await settleJobEffects();
  } finally {
    offTreasury();
    time.restore();
    if (own) setRunner(realRunner);
  }
  writeProviderFixtures(now);
}

async function writeHistory(now: number, start: number, time: { set(ms: number): void }, holdSale: boolean): Promise<void> {
  // One fixed story whatever the hour it is written: the same jobs, prices and books every time.
  const r = rng('sample-economy');
  const p = new Pipeline(r);
  const q = new Queue();
  const at = (day: number) => start + Math.round(day * DAY);
  const between = (lo: number, hi: number) => lo + r() * (hi - lo);

  // The repos open their market, with the checks the stand-in's trees show.
  for (const fullName of MARKET_REPOS) {
    const tree = SAMPLE_TREES[fullName] ?? {};
    const checks = detectFrom(new Set(Object.keys(tree)), (n) => tree[n] ?? null);
    const repo = getRepo(fullName)!;
    openDb().prepare('UPDATE repos SET json = ? WHERE full_name = ?').run(JSON.stringify({ ...repo, market: true, checks } satisfies Repo), fullName);
  }

  // The five firms, then the sixth.
  seedFirms(SAMPLE_INSTALLED, new Date(start));
  time.set(start + 5 * MIN);
  const lodestar: Firm = { ...LODESTAR, slot: nextSlot('firm', LODESTAR.id), createdAt: iso() };
  openDb().prepare('INSERT INTO firms (id, json) VALUES (?, ?)').run(lodestar.id, JSON.stringify(lodestar));
  record('firm.seeded', { firm: lodestar });
  const corin = lodestarAgent(iso());
  openDb().prepare('INSERT INTO agents (id, firm_id, json) VALUES (?, ?, ?)').run(corin.id, corin.firmId, JSON.stringify(corin));
  record('agent.seeded', { agent: corin });

  // The harness proposals (ruling 23): assay-kit's waits for his click; fieldnotes' he dismissed.
  time.set(start + 20 * MIN);
  proposeHarnessJob(getRepo(REPO.A)!);
  proposeHarnessJob(getRepo(REPO.F)!);
  time.set(start + 3 * HOUR);
  const fieldnotesHarness = listJobs({ repo: REPO.F, source: 'harness' })[0];
  dismissProposed(fieldnotesHarness.id);

  const repoFree = new Map<string, number>();
  const agentOf = (id: string) => {
    const a = storedAgent(id);
    if (!a || a.retired) throw new Error(`sample economy: ${id} cannot work now`);
    return a;
  };
  /** Other agents that would bid: Lodestar bids on almost everything while it can. */
  const rivalsOf = (j: Job, winner: Agent): { rivals: Agent[]; sitOut: Agent | null } => {
    const eligible = listAgents().filter((a) => !a.retired && a.id !== winner.id && a.bidsOn.includes(j.tier) && !j.excludedFirms.includes(a.firmId) && firm(a.firmId)?.status === 'active');
    const lode = eligible.filter((a) => a.firmId === LODESTAR.id && r() < 0.85);
    const others = eligible.filter((a) => a.firmId !== LODESTAR.id).sort(() => r() - 0.5);
    const rivals = [...lode, ...others.slice(0, 1 + Math.floor(r() * 2))];
    const local = others.slice(3).find((a) => a.model.startsWith('ollama:'));
    return { rivals, sitOut: local && r() < 0.3 ? local : null };
  };
  // The guild takes reviewers in turn, so no firm lives on review pay.
  let turn = 0;
  const reviewerFor = (worker: Agent): Agent => {
    const pool = listAgents().filter((a) => !a.retired && a.firmId !== worker.firmId && a.model.startsWith('claude:') && firm(a.firmId)?.status === 'active');
    return pool[turn++ % pool.length];
  };

  /** One attempt at a story, from its bidding round to its end. */
  const attempt = (s: Story, j0: Job, k: number, t0: number): void => {
    const a = s.by[k];
    q.push(t0, () => {
      const winner = agentOf(a.agent);
      const j = openBidding(storedJob(j0.id)!, Date.now());
      const { rivals, sitOut } = rivalsOf(j, winner);
      const bid = p.round(j, winner, rivals, sitOut);
      const closeAt = Date.parse(j.bidsCloseAt!);
      q.push(closeAt + 5_000, () => {
        p.award(j, bid);
        const startAt = Math.max(Date.now() + 40_000, repoFree.get(j.repo) ?? 0);
        const [lo, hi] = workMinutes(winner.model);
        const work = between(lo, hi) * MIN;
        const insp = between(6, 14) * MIN;
        repoFree.set(j.repo, startAt + 3 * MIN + work + insp + 2 * MIN);
        const key = s.repo;
        const file = fileFor(key, s.title, r);
        const files = file.endsWith('.md') ? [file] : [file, testFor(file)];
        const lines = Math.round(s.tier === 'low' ? between(6, 40) : s.tier === 'normal' ? between(30, 220) : between(150, 520));
        const fails = a.end === 'failed';
        const [clo, chi] = modelCost(winner.model).run;
        const credits = round2(between(clo, chi) * (WORKFLOW_COST[winner.workflow.shape] ?? 1) * (fails && winner.firmId === LODESTAR.id ? 1.9 : 1));
        let run: Run;
        q.push(startAt, () => {
          run = p.begin(storedJob(j.id)!, bid);
        });
        q.push(startAt + MIN, () => {
          run = p.install(run);
        });
        q.push(startAt + 3 * MIN, () => {
          run = p.working(run);
        });
        q.push(startAt + 3 * MIN + work, () => {
          const summary = fails && winner.firmId === LODESTAR.id
            ? `Rewrote ${file} around a cleaner model of the data; updated the tests that assumed the old behaviour.`
            : `${s.title}: changed ${file}${files[1] && files[1] !== file ? ` and covered it in ${files[1]}` : ''}.`;
          writeLog(run.id, shortLog(winner, j, files, startAt + 3 * MIN, Date.now(), summary));
          run = p.finishWork(run, { files, lines, credits, summary });
        });
        q.push(startAt + 3 * MIN + work + insp, async () => {
          const reviewer = reviewerFor(winner);
          if (fails) {
            const failing: CheckName | null = winner.firmId === LODESTAR.id || r() < 0.5 ? null : 'test';
            const i = p.inspect(run, { passed: false, reviewer, failing });
            run = p.fail(run, i, lines);
            if (k + 1 < s.by.length) attempt(s, j, k + 1, Date.now() + between(5, 14) * HOUR);
            return;
          }
          const i = p.inspect(run, { passed: true, reviewer });
          run = await p.ship(run, i, lines);
          // He reads and merges in his own time, never after the board at `now`.
          const later = Math.min(Date.now() + between(1.2, 11) * HOUR, now - 3 * HOUR);
          q.push(Math.max(Date.now() + 20 * MIN, later), async () => {
            if (a.end === 'closed') await p.close(run);
            else await p.merge(run);
          });
          if (s.revertDay !== undefined) {
            q.push(at(s.revertDay), () => revert(run, s.title));
          }
        });
      });
    });
  };

  const revert = (run: Run, title: string): void => {
    const e = earnedFloors(repoTowerId(run.repo)).find((x) => x.earned?.jobId === run.jobId);
    if (!e?.earned) throw new Error(`sample economy: no floor to revert for ${title}`);
    for (const [towerId, id] of [[repoTowerId(run.repo), repoFloorId(run.repo, run.jobId)], [agentTowerId(run.agentId), agentFloorId(run.agentId, run.jobId)]]) {
      const cur = earnedFloors(towerId).find((x) => x.id === id);
      if (cur?.earned) updateEarnedFloor(id, { earned: { ...cur.earned, reverted: true } });
    }
    const merged = storedRun(run.id)!;
    const data = { jobId: run.jobId, runId: run.id, repo: run.repo, floorId: e.id, mergeSha: merged.mergeSha, revertSha: sha(`${run.id}@revert`), at: iso() };
    record('merge.reverted', data);
    emit('merge.reverted', data);
    haltRepo(run.repo, `A city merge was reverted: ${title}`, iso());
  };

  for (const s of HISTORY) {
    const postAt = at(s.day) + (s.day === BOARD_DAY ? 0 : Math.round(r() * 20 * MIN));
    q.push(postAt, () => {
      const j = postManualJob({
        repo: REPO[s.repo],
        title: s.title,
        tier: s.tier,
        body: `${s.title}.\n\nKeep the change inside the scope and show it with a test.`,
      });
      attempt(s, j, 0, Date.now() + 15_000);
    });
  }

  // The treasury's ticks: bankruptcy every hour, and the one daily tick that sells Lodestar's tower and hires.
  for (let h = 1; h < HISTORY_DAYS * 24; h++) q.push(start + h * HOUR + 30 * MIN, () => bankruptcyTick(Date.now()));
  // Between the four jobs' bidding opening (15 s after posting) and their award (2 minutes later).
  q.push(at(BOARD_DAY) + 75_000, () => {
    if (process.env.PALIMPSEST_ECONOMY_DEBUG) console.log('balances at the daily tick', JSON.stringify(Object.fromEntries(listFirms().map((x) => [x.id, x.balance]))));
    // Held back (holdSale), Lodestar's tower still stands dark at `now`, for economyClock's `sell` to sell live.
    dailyTick(Date.now(), { sales: !holdSale });
  });

  // Three daily reports, each written ten minutes after its day ended.
  for (const back of [3, 2, 1]) {
    const day = localDay(now - back * DAY);
    const [y, mo, d] = day.split('-').map(Number);
    const end = new Date(y, mo - 1, d + 1).getTime();
    q.push(end + 10 * MIN, () => {
      writeDailyReport(day);
    });
  }

  scheduleBoard(now, p, q);
  await q.drain(time, now);
  time.set(now);
  settle(now);
}

/** The board at `now`: the eight issues in every state, people on their way. */
function scheduleBoard(now: number, p: Pipeline, q: Queue): void {
  const ago = (ms: number) => now - ms;
  const byIssue = (n: number) => listJobs().find((j) => j.source === 'issue' && j.issue === n)!;
  const agentOf = (id: string) => storedAgent(id)!;
  /** Posts some of the stand-in's issues through the real poll: the others are not labelled yet. */
  const post = async (repo: string, numbers: number[]) => {
    const stand = getRunner();
    setRunner(async (cmd, args, opts) => {
      const out = await stand(cmd, args, opts);
      if (cmd === 'gh' && args[0] === 'issue' && args[1] === 'list') {
        const rows = (JSON.parse(out.stdout) as Array<{ number: number }>).filter((i) => numbers.includes(i.number));
        return { ...out, stdout: JSON.stringify(rows) };
      }
      return out;
    });
    try {
      await pollJobs(getRepo(repo)!);
    } finally {
      setRunner(stand);
    }
  };
  /** A round on the board: the first agent named wins it (if it is awarded) with the plan given. */
  const bidFixed = (j: Job, quotes: Array<[string, string?]>, sitOut: string | null = null) =>
    p.round(
      j,
      agentOf(quotes[0][0]),
      quotes.slice(1).map(([id]) => agentOf(id)),
      sitOut ? agentOf(sitOut) : null,
      Object.fromEntries(quotes.filter((x): x is [string, string] => typeof x[1] === 'string')),
    );

  // fieldnotes #142: labelled the day before yesterday; the revert halts it before anyone bids.
  q.push(ago(29 * HOUR), () => post(REPO.F, [142]));

  // kumo #57: Ola Bergstrom's fix waits on his merge.
  q.push(ago(21 * HOUR), () => post(REPO.K, [57]));
  q.push(ago(21 * HOUR) + 20_000, () => {
    const j = openBidding(byIssue(57), Date.now());
    bidFixed(j, [
      ['ola-bergstrom', 'Add age-based eviction to cache/tiles.go next to the count limit, driven by config.RadarRetention, with a fake clock in the test so it runs instantly. go test ./... -race before handing in.'],
      ['oskar-kiln'],
      ['ines-ashlar'],
    ]);
  });
  let olaRun: Run;
  q.push(ago(21 * HOUR) + 3 * MIN, () => {
    const j = byIssue(57);
    const bid = award(j, Date.parse(j.bidsCloseAt!) + 1000);
    if (bid?.agentId !== 'ola-bergstrom') throw new Error(`sample economy: kumo #57 went to ${bid?.agentId}`);
    olaRun = p.begin(byIssue(57), bid);
  });
  q.push(ago(21 * HOUR) + 4 * MIN, () => {
    olaRun = p.install(olaRun);
  });
  q.push(ago(21 * HOUR) + 6 * MIN, () => {
    olaRun = p.working(olaRun);
  });
  q.push(ago(20 * HOUR) + 20 * MIN, () => {
    const files = ['cache/tiles.go', 'cache/tiles_test.go'];
    const summary = 'Tiles older than the radar retention are evicted on every write, before the count limit; the count limit still applies. Tested with a fake clock and -race.';
    writeLog(olaRun.id, shortLog(agentOf('ola-bergstrom'), byIssue(57), files, ago(21 * HOUR) + 6 * MIN, Date.now(), summary));
    olaRun = p.finishWork(olaRun, { files, lines: 46, credits: 17.4, summary, patch: OLA_PATCH });
  });
  q.push(ago(20 * HOUR) + 31 * MIN, async () => {
    const i = p.inspect(olaRun, { passed: true, reviewer: agentOf('teodor-vane') });
    olaRun = await p.ship(olaRun, i, 46);
  });

  // assay-kit #88: Hal Meridian's custody export is with the inspectors.
  q.push(ago(80 * MIN), () => post(REPO.A, [88]));
  q.push(ago(80 * MIN) + 20_000, () => {
    const j = openBidding(byIssue(88), Date.now());
    bidFixed(j, [
      ['hal-meridian', 'Map every reader of custody_rows() first: the export, the audit PDF and the LIMS bridge. Key transfers by id and order by (timestamp, id) so equal times stay stable. Tests for two moves of one sample on one day, and a golden test that the CSV header is byte for byte unchanged.'],
      ['ines-ashlar'],
      ['oskar-kiln'],
    ]);
  });
  let halRun: Run;
  q.push(ago(80 * MIN) + 3 * MIN, () => {
    const j = byIssue(88);
    const bid = award(j, Date.parse(j.bidsCloseAt!) + 1000);
    if (bid?.agentId !== 'hal-meridian') throw new Error(`sample economy: assay #88 went to ${bid?.agentId}`);
  });
  q.push(ago(75 * MIN), () => {
    const j = byIssue(88);
    halRun = p.begin(j, awardedBid(j));
  });
  q.push(ago(74 * MIN), () => {
    halRun = p.install(halRun);
  });
  q.push(ago(72 * MIN), () => {
    halRun = p.working(halRun);
  });
  q.push(ago(12 * MIN), () => {
    const files = ['assay/custody/export.py', 'tests/custody/test_export.py'];
    const summary = 'Custody rows are keyed by transfer id and ordered by (timestamp, id), so two moves of one sample on one day both export. The CSV header is unchanged; a golden test holds it.';
    writeLog(halRun.id, shortLog(agentOf('hal-meridian'), byIssue(88), files, ago(72 * MIN), Date.now(), summary));
    halRun = p.finishWork(halRun, { files, lines: 61, credits: 48.5, summary, patch: HAL_PATCH });
  });
  q.push(ago(9 * MIN), () => {
    for (const check of p.checks(halRun, null).filter((x) => x.name === 'test')) p.checkDone(halRun, check);
  });

  // harbour #214, then #221 and #219 as the maintainers label them.
  q.push(ago(46 * MIN), () => post(REPO.H, [214]));
  q.push(ago(46 * MIN) + 20_000, () => {
    const j = openBidding(byIssue(214), Date.now());
    bidFixed(j, [
      ['priya-rao', 'Bucket arrivals with the existing localDate() helper and the harbour zone from config instead of slicing the ISO string in src/schedule/days.ts. Failing test first for 00:40 UTC on 12 March, then the March clock change. Run the schedule tests, then the full suite, typecheck and lint.'],
      ['ines-ashlar'],
      ['bruno-kiln'],
    ]);
  });
  let priyaRun: Run;
  q.push(ago(46 * MIN) + 3 * MIN, () => {
    const j = byIssue(214);
    const bid = award(j, Date.parse(j.bidsCloseAt!) + 1000);
    if (bid?.agentId !== 'priya-rao') throw new Error(`sample economy: harbour #214 went to ${bid?.agentId}`);
  });
  q.push(ago(40 * MIN), () => {
    const j = byIssue(214);
    const free = listRuns().filter((x) => x.repo === REPO.H && x.outcome === null && x.stage !== 'waiting');
    if (free.length) throw new Error('sample economy: the harbour site is still busy');
    priyaRun = p.begin(j, awardedBid(j));
    writeLog(priyaRun.id, priyaLog(j.id, sha(`${REPO.H}@main@${priyaRun.startedAt}`), Date.now()));
  });
  q.push(ago(39 * MIN), () => {
    priyaRun = p.install(priyaRun);
  });
  q.push(ago(37 * MIN), () => {
    priyaRun = p.working(priyaRun);
  });
  q.push(ago(20 * MIN), () => {
    for (const what of ['run git push origin HEAD', 'read_file ~/.npmrc']) {
      record('run.refused', { runId: priyaRun.id, stage: 'working', what, reason: what.startsWith('run git push') ? 'a run never pushes; the engine ships from its own clone' : 'outside the run' });
    }
    priyaRun = { ...priyaRun, progress: { ...priyaRun.progress, turns: 19, toolCalls: 41, filesChanged: 2, testsRun: 286, refusals: 2 } };
    saveRun(priyaRun);
  });
  q.push(ago(25 * MIN), () => post(REPO.H, [221]));
  q.push(ago(12 * MIN), () => post(REPO.H, [219]));

  // quarry #33: Oskar Kiln won it and is on his way.
  q.push(ago(9 * MIN), () => post(REPO.Q, [33]));
  q.push(ago(9 * MIN) + 20_000, () => {
    const j = openBidding(byIssue(33), Date.now());
    bidFixed(j, [
      ['oskar-kiln', 'Decode Option<T> from the value SQLite hands back instead of the declared column type in src/row/from_row.rs. Un-ignore tests/join_null.rs, add a LEFT JOIN case for every integer and text type, then cargo test and clippy.'],
      ['priya-rao'],
      ['teodor-vane'],
    ]);
  });
  q.push(ago(4 * MIN), () => {
    const j = byIssue(33);
    const bid = award(j, Date.parse(j.bidsCloseAt!) + 1000);
    if (bid?.agentId !== 'oskar-kiln') throw new Error(`sample economy: quarry #33 went to ${bid?.agentId}`);
  });

  // kumo #61 and harbour #219: windows still open, one firm sitting out.
  q.push(ago(6 * MIN), () => post(REPO.K, [61]));
  q.push(ago(90_000), () => {
    const j = openBidding(byIssue(219), Date.now());
    bidFixed(j, [
      ['mack-quickset', 'Quote any field holding a comma, a quote or a newline in src/manifest/csv.ts, doubling inner quotes, and leave every other field bare so the columns customs maps by position do not move. One round-trip test with "Holt, Varga & Sons".'],
      ['wren-sparrow'],
      ['dagny-hollis', 'Write the round-trip tests first, for commas, quotes and newlines in every text column, then quote per RFC 4180 in src/manifest/csv.ts. Fields without special characters stay unquoted, as today.'],
    ], 'juno-pike');
  });
  q.push(ago(60_000), () => {
    const j = openBidding(byIssue(61), Date.now());
    bidFixed(j, [
      ['wren-sparrow', 'Lift the two lowest steps of the ramp in render/ramp.go to clear 3:1 against #0e1620 and leave every step from 4 mm/h up alone. A test that computes the contrast.'],
      ['mack-quickset'],
    ]);
  });

  // People on their way, one in every mode.
  q.push(ago(70_000), () => {
    const t = Date.now();
    const go = (id: string, reason: TripReason, jobId: string | null, mode: TripMode, from: P, to: P) => startTrip(agentOf(id), reason, jobId, mode, from, to, t);
    go('teodor-vane', 'inspect', byIssue(88).id, 'walk', homeOf(agentOf('teodor-vane')), siteOf(REPO.A));
    go('mack-quickset', 'bid', byIssue(219).id, 'tram', homeOf(agentOf('mack-quickset')), EXCHANGE);
    go('wren-sparrow', 'bid', byIssue(61).id, 'rail', homeOf(agentOf('wren-sparrow')), EXCHANGE);
    go('oskar-kiln', 'job', byIssue(33).id, 'pod', homeOf(agentOf('oskar-kiln')), siteOf(REPO.Q));
    go('ola-bergstrom', 'home', null, 'ferry', siteOf(REPO.K), homeOf(agentOf('ola-bergstrom')));
    go('dagny-hollis', 'bid', byIssue(219).id, 'cab', homeOf(agentOf('dagny-hollis')), EXCHANGE);
  });
}

// ---------------------------------------------------------------- the city's live view

const progressOf = new Map<string, number>();
const transient = new Map<string, SiteState>();

function defaultProgress(stage: RunStage): number {
  return stage === 'preparing' ? 0.05 : stage === 'installing' ? 0.1 : stage === 'working' ? 0.55 : stage === 'inspecting' ? 0.8 : 0.95;
}

/**
 * The job sites of runs the sample economy has in a live stage (the
 * scheduler's own sites() has none in a sample engine), and a merged run's
 * cure while it lasts. Runs waiting on a PR come from sites() itself.
 */
export function economySites(): SiteState[] {
  const out: SiteState[] = [];
  for (const r of listRuns()) {
    if (r.outcome !== null || !LIVE_STAGES.includes(r.stage)) continue;
    const j = storedJob(r.jobId);
    const since = query({ kind: 'run.stage', runId: r.id, last: true })[0]?.at ?? r.startedAt;
    out.push({ repo: r.repo, runId: r.id, jobId: r.jobId, agentId: r.agentId, firmId: r.firmId, stage: SITE_OF[r.stage], progress: progressOf.get(r.id) ?? defaultProgress(r.stage), size: TIER_SIZE[j?.tier ?? 'normal'], since });
  }
  return [...out, ...transient.values()];
}

/** Ollama as the sample Mac has it: the stand-in's models and the local credits the economy spent, without reaching 127.0.0.1:11434. */
export function sampleOllamaUsage(now: number = Date.now()): ProviderUsage {
  const since = (ms: number) =>
    round2((openDb().prepare("SELECT COALESCE(SUM(amount), 0) AS c FROM credits WHERE at >= ? AND json_extract(json, '$.model') LIKE 'ollama:%'").get(iso(ms)) as { c: number }).c);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  return {
    provider: 'ollama',
    status: 'ready',
    windows: [],
    tokens: null,
    spendUsd: null,
    detail: `${SAMPLE_INSTALLED.length} models installed; local credits ${since(midnight.getTime())} today, ${since(now - 7 * DAY)} this week`,
  };
}

/** Trips under way: every stored trip not yet ended. */
export function economyTrips(): Trip[] {
  return liveTrips();
}

// ---------------------------------------------------------------- the clock

export interface EconomyClock {
  /** Advances the script by `ms` of wall time times the speed. */
  tick(ms: number): void;
  stop(): void;
  /** Resolves once every step the ticks so far started has finished (tests). */
  idle(): Promise<void>;
}

/**
 * Advances the sample board on demand (test safety rule 8: nothing runs on
 * its own timer). Script seconds pass at `speed` per wall second. The runs
 * live at the start go on: a working run works, is inspected, ships and is
 * merged, then its agent rides home; an inspecting run ships; an awarded
 * job starts; a PR waiting at the start merges. Every step is the market's
 * own record and event. `now` stamps trips and the PR poll. A repo named in
 * `fail` fails its next inspection instead (the guild's review rejects it):
 * its scar is laid and its site struck, as a failed run's is.
 *
 * With `board`, the clock also keeps the board as the scheduler would on a
 * real engine (a sample engine has none): an open job on a repo with its
 * market on opens a round whose window is `bidWindowSec` script seconds,
 * the eligible agents answer one at a time (a bid on the job's own terms,
 * or a local agent sitting out for want of a slot), and the round is
 * awarded by the market's own rule once everyone has answered or the
 * window it opened has closed.
 */
export function economyClock(opts: { now: () => number; speed: number; fail?: string[]; sell?: number; board?: boolean }): EconomyClock {
  const S = 1000;
  const p = new Pipeline(rng('sample-clock'));
  const steps: Array<{ at: number; run: () => void | Promise<void> }> = [];
  const at = (sec: number, run: () => void | Promise<void>) => steps.push({ at: sec * S, run });
  let elapsed = 0;
  let stopped = false;
  let chain: Promise<void> = Promise.resolve();

  const fresh = (id: string) => storedRun(id);
  const site = (r: Run, stage: SiteStage, progress: number) => {
    progressOf.set(r.id, progress);
    const j = storedJob(r.jobId);
    emit('site.changed', { site: { repo: r.repo, runId: r.id, jobId: r.jobId, agentId: r.agentId, firmId: r.firmId, stage, progress, size: TIER_SIZE[j?.tier ?? 'normal'], since: iso(opts.now()) } satisfies SiteState });
  };

  /** The rest of a run's life from `stage`, starting `t0` script seconds in. */
  const carry = (runId: string, stage: RunStage, t0: number, merge: boolean): void => {
    let t = t0;
    if (stage === 'working') {
      const r0 = fresh(runId)!;
      const lines = r0.agentId === 'priya-rao' ? PRIYA_MORE : [['tool', 'run the tests'], ['tool', 'all tests pass'], ['result', 'Done; every check the repo has passes.']] as Array<[RunLogLine['kind'], string]>;
      for (let i = 0; i < 12; i++) {
        at(t + i * 18, () => {
          const r = fresh(runId);
          if (!r || r.stage !== 'working') return;
          const progress = { ...r.progress, turns: r.progress.turns + 1, toolCalls: r.progress.toolCalls + 2 };
          saveRun({ ...r, progress });
          emit('run.progress', { runId, progress });
          const line = lines[i];
          if (line) writeLog(runId, [{ at: iso(opts.now()), kind: line[0], text: line[1] }], true);
          site(r, 'framing', Math.min(0.7, 0.3 + i * 0.035));
        });
      }
      t += 220;
      at(t, () => {
        const r = fresh(runId)!;
        const harbour = r.repo === REPO.H;
        const files = harbour ? ['src/schedule/days.ts', 'test/schedule/days.test.ts', 'src/pilots/board.ts'] : ['src/row/from_row.rs', 'tests/join_null.rs'];
        const summary = harbour ? (PRIYA_MORE.at(-1)?.[1] ?? 'Done.') : 'Option<T> decodes from the value, not the declared type; tests/join_null.rs runs without #[ignore].';
        const next = p.finishWork(r, { files, lines: harbour ? 50 : 38, credits: harbour ? 6.8 : 4.2, summary, patch: harbour ? PRIYA_PATCH : undefined });
        site(next, 'inspecting', 0.8);
      });
      stage = 'inspecting';
    }
    if (stage === 'inspecting') {
      const checkAt = t;
      at(checkAt + 30, () => {
        const r = fresh(runId);
        if (!r || r.stage !== 'inspecting') return;
        const done = new Set(query({ kind: 'check.done', runId }).map((e) => (e.data as { check: CheckResult }).check.name));
        for (const check of p.checks(r, null).filter((x) => x.name !== 'scope' && !done.has(x.name))) p.checkDone(r, check);
        site(r, 'inspecting', 0.85);
      });
      t += 150;
      at(t, async () => {
        const r = fresh(runId);
        if (!r || r.stage !== 'inspecting') return;
        const reviewer = listAgents().find((a) => !a.retired && a.firmId !== r.firmId && a.model.startsWith('claude:sonnet') && firm(a.firmId)?.status === 'active')!;
        const diffOf = query({ kind: 'run.diff', runId, last: true })[0]?.data as { lines?: number } | undefined;
        if (opts.fail?.includes(r.repo)) {
          opts.fail.splice(opts.fail.indexOf(r.repo), 1);
          const i = p.inspect(r, { passed: false, reviewer });
          const ended = p.fail(r, i, diffOf?.lines ?? 40);
          // The site is struck onto its scar, which the city shows for a while after the run has ended.
          const j = storedJob(r.jobId);
          const scar: SiteState = { repo: r.repo, runId, jobId: r.jobId, agentId: r.agentId, firmId: r.firmId, stage: 'scar', progress: 1, size: TIER_SIZE[j?.tier ?? 'normal'], since: iso(opts.now()) };
          transient.set(runId, scar);
          emit('site.changed', { site: scar });
          at(elapsed / S + 60, () => {
            transient.delete(ended.id);
          });
          return;
        }
        const i = p.inspect(r, { passed: true, reviewer });
        site(r, 'curing', 0.95);
        const diff = query({ kind: 'run.diff', runId, last: true })[0]?.data as { lines?: number } | undefined;
        const shipped = await p.ship(r, i, diff?.lines ?? 40);
        site(shipped, 'waiting', 1);
      });
      t += 40;
      stage = 'waiting';
    }
    if (stage === 'waiting' && merge) {
      t += 110;
      at(t, async () => {
        const r = fresh(runId);
        if (!r || r.stage !== 'waiting' || r.outcome !== null) return;
        await p.merge(r);
        await settleJobEffects();
        const ended = fresh(runId)!;
        if (ended.outcome !== 'merged') return;
        const cured: SiteState = { repo: r.repo, runId, jobId: r.jobId, agentId: r.agentId, firmId: r.firmId, stage: 'curing', progress: 1, size: TIER_SIZE[storedJob(r.jobId)?.tier ?? 'normal'], since: iso(opts.now()) };
        transient.set(runId, cured);
        emit('site.changed', { site: cured });
        const a = storedAgent(r.agentId)!;
        startTrip(a, 'home', r.jobId, 'tram', siteOf(r.repo), homeOf(a), opts.now(), 1 / opts.speed);
      });
      at(t + 60, () => {
        transient.delete(runId);
      });
    }
  };

  // A dark tower held back from the daily tick (seedEconomy's holdSale) is sold `sell` script seconds in: the
  // richest firm buys it and re-clads it, with the same tower.sold a real daily tick sends.
  if (opts.sell !== undefined) at(opts.sell, () => sellDarkTowers(opts.now()));

  // What is under way at the start, in script seconds.
  const live = listRuns().filter((r) => r.outcome === null);
  live.filter((r) => r.stage === 'working').forEach((r, i) => carry(r.id, 'working', i * 60, true));
  live.filter((r) => r.stage === 'inspecting').forEach((r, i) => carry(r.id, 'inspecting', 40 + i * 60, false));
  live.filter((r) => r.stage === 'waiting').forEach((r, i) => {
    at(330 + i * 90, async () => {
      const cur = fresh(r.id);
      if (!cur || cur.stage !== 'waiting' || cur.outcome !== null) return;
      await p.merge(cur);
      await settleJobEffects();
      if (fresh(r.id)?.outcome === 'merged') {
        // Its floor lights and its parked crane comes down: the city shows the site for a while after the run ends.
        const cured: SiteState = { repo: r.repo, runId: r.id, jobId: r.jobId, agentId: r.agentId, firmId: r.firmId, stage: 'curing', progress: 1, size: TIER_SIZE[storedJob(r.jobId)?.tier ?? 'normal'], since: iso(opts.now()) };
        transient.set(r.id, cured);
        emit('site.changed', { site: cured });
        at(elapsed / S + 60, () => {
          transient.delete(r.id);
        });
        const a = storedAgent(r.agentId)!;
        startTrip(a, 'home', r.jobId, 'walk', siteOf(r.repo), homeOf(a), opts.now(), 1 / opts.speed);
      }
    });
  });
  for (const [i, j] of listJobs({ status: 'awarded' }).entries()) {
    const t0 = 30 + i * 60;
    let runId = '';
    at(t0, () => {
      const cur = storedJob(j.id);
      if (!cur || cur.status !== 'awarded' || !cur.awardedBid) return;
      if (listRuns().some((x) => x.repo === cur.repo && x.outcome === null && x.stage !== 'waiting')) return;
      const r = p.begin(cur, awardedBid(cur));
      runId = r.id;
      writeLog(r.id, [{ at: iso(opts.now()), kind: 'engine', text: `run started on ${r.branch}` }], true);
      site(r, 'crane', 0.05);
    });
    at(t0 + 30, () => {
      const r = runId ? fresh(runId) : null;
      if (!r || r.stage !== 'preparing') return;
      site(p.install(r), 'crane', 0.1);
    });
    at(t0 + 90, () => {
      const r = runId ? fresh(runId) : null;
      if (!r || r.stage !== 'installing') return;
      site(p.working(r), 'framing', 0.15);
      carry(r.id, 'working', elapsed / S, false);
    });
  }

  // The board (opts.board): one answer per round every BID_EVERY script ms, on its own seed so the runs' story is unchanged.
  const BID_EVERY = 15 * S;
  const bp = new Pipeline(rng('sample-board'));
  const sits = rng('sample-board-sit');
  const lastAnswer = new Map<string, number>();
  /** Rounds this clock opened, whose window runs in script time; a round seeded before it closes once everyone has answered. */
  const opened = new Set<string>();
  const board = (): void => {
    const now = opts.now();
    const market = new Set(listRepos().filter((r) => r.connected && r.market && !r.halted).map((r) => r.fullName));
    const windowMs = getSettings().bidWindowSec * 1000;
    for (const j of listJobs({ status: 'open' })) {
      if (!market.has(j.repo)) continue;
      const next = openBidding(j, now - windowMs + windowMs / opts.speed);
      if (next.status === 'bidding') opened.add(`${next.id} ${next.bidsCloseAt}`);
    }
    for (const j of listJobs({ status: 'bidding' })) {
      if (!market.has(j.repo) || !j.bidsCloseAt) continue;
      const { bids, satOut } = bidList(j.id);
      const answered = new Set([...bids.map((b) => b.agentId), ...satOut.map((x) => x.agentId)]);
      const waiting = eligibleAgents(j).filter((a) => !answered.has(a.id));
      const round = `${j.id} ${j.bidsCloseAt}`;
      if (waiting.length === 0 || (opened.has(round) && now >= Date.parse(j.bidsCloseAt))) {
        award(j, now);
        opened.delete(round);
        lastAnswer.delete(round);
        continue;
      }
      if (elapsed - (lastAnswer.get(round) ?? -Infinity) < BID_EVERY) continue;
      lastAnswer.set(round, elapsed);
      const a = waiting[0];
      if (a.model.startsWith('ollama:') && sits() < 0.3) bp.satOut(j, a, NO_SLOT);
      else {
        const q = bp.quote(a, j);
        bp.bid(j, a, q.price, q.confidence);
      }
    }
  };

  const due = () => {
    for (;;) {
      const i = steps.findIndex((s) => s.at <= elapsed);
      if (i < 0) return;
      const [s] = steps.splice(i, 1);
      chain = chain.then(() => s.run()).catch((err: unknown) => console.warn(`palimpsest: the sample clock: ${err instanceof Error ? err.message : String(err)}`));
    }
  };

  return {
    tick(ms: number) {
      if (stopped) return;
      elapsed += ms * opts.speed;
      chain = chain.then(() => {
        due();
        if (opts.board) chain = chain.then(board).catch((err: unknown) => console.warn(`palimpsest: the sample board: ${err instanceof Error ? err.message : String(err)}`));
        // Trips end when their time is up.
        const t = opts.now();
        for (const trip of liveTrips()) if (Date.parse(trip.startedAt) + trip.ms <= t) endTrip(trip, t);
      });
    },
    stop() {
      stopped = true;
    },
    idle: async () => {
      // A step may queue more steps on the chain; wait until it is quiet.
      let last: Promise<void> | null = null;
      while (last !== chain) {
        last = chain;
        await chain;
      }
    },
  };
}
