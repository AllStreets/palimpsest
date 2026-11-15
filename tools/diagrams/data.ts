/**
 * Every word the README's diagrams draw, taken from the code's own lists
 * (Phase 5 ruling 11). Each list is checked against the type it names: a
 * job state, run stage, check, net, floor state or egress stage added to the
 * code and not drawn here fails the typecheck, and test/diagrams.test.ts
 * fails when a drawn move, kind or port no longer matches the code.
 *
 * What the code holds as values (the legal moves, the ports, the ledger
 * kinds, the never list, the school's numbers) is imported or read, never
 * copied.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LABEL as LAUNCHD_LABEL } from '../../engine/launchd.js';
import { hostsFor, type EgressStage } from '../../engine/market/egress.js';
import { FORBIDDEN_REASONS } from '../../engine/market/guard.js';
import { RESERVED_PORTS } from '../../engine/market/guard-core.mjs';
import { OLLAMA_PORT, SECRET_PATHS } from '../../engine/market/sandbox.js';
import { DEFAULT_PORT } from '../../engine/server.js';
import { LEDGER_KINDS, type LedgerKind } from '../../shared/ledger-kinds.js';
import { LEGAL_MOVES, MAX_ATTEMPTS, REGISTRY_HOSTS, TIER_VALUE } from '../../shared/market-rules.js';
import { AGREE, ARENA, HELD_OUT, LORA, NET_MIN, SEALED_USES, VOYAGE, WORK_KINDS } from '../../shared/school-rules.js';
import type { CheckName, CheckStatus, EarnedFloor, JobStatus, NetName, RunStage, WorkKind } from '../../shared/types.js';

export { AGREE, ARENA, DEFAULT_PORT, HELD_OUT, LAUNCHD_LABEL, LEGAL_MOVES, LORA, MAX_ATTEMPTS, NET_MIN, OLLAMA_PORT, RESERVED_PORTS, SEALED_USES, TIER_VALUE, VOYAGE, WORK_KINDS };

/** True only when `Missing` is `never`: an exhaustiveness check that fails the typecheck, not a test. */
type Complete<Missing> = [Missing] extends [never] ? true : false;

// ---------------------------------------------------------------- the floor

/** A job's states, in the order a job that ships walks them, then the ends it can leave by. */
export const JOB_STATES = ['proposed', 'open', 'bidding', 'awarded', 'running', 'inspecting', 'shipping', 'waiting', 'merged', 'failed', 'halted', 'withdrawn', 'closed'] as const satisfies readonly JobStatus[];
const jobStatesComplete: Complete<Exclude<JobStatus, (typeof JOB_STATES)[number]>> = true;

/** The states on the main line, left to right; the rest are exits drawn as rows beneath it. */
export const JOB_LINE = ['proposed', 'open', 'bidding', 'awarded', 'running', 'inspecting', 'shipping', 'waiting', 'merged'] as const satisfies readonly JobStatus[];
export const JOB_EXITS = ['failed', 'withdrawn', 'closed', 'halted'] as const satisfies readonly JobStatus[];
const jobSplitComplete: Complete<Exclude<JobStatus, (typeof JOB_LINE)[number] | (typeof JOB_EXITS)[number]>> = true;

export const JOB_STATE_LABEL: Record<JobStatus, string> = {
  proposed: 'Proposed',
  open: 'Open',
  bidding: 'Bidding',
  awarded: 'Awarded',
  running: 'Running',
  inspecting: 'Inspecting',
  shipping: 'Shipping',
  waiting: 'Waiting',
  merged: 'Merged',
  failed: 'Failed',
  halted: 'Halted',
  withdrawn: 'Withdrawn',
  closed: 'Closed',
};

/** A run's stages, in order. */
export const RUN_STAGES = ['preparing', 'installing', 'working', 'inspecting', 'shipping', 'waiting', 'done'] as const satisfies readonly RunStage[];
const runStagesComplete: Complete<Exclude<RunStage, (typeof RUN_STAGES)[number]>> = true;

export const RUN_STAGE_LABEL: Record<RunStage, string> = {
  preparing: 'Preparing',
  installing: 'Installing',
  working: 'Working',
  inspecting: 'Inspecting',
  shipping: 'Shipping',
  waiting: 'Waiting',
  done: 'Done',
};

/**
 * The job state each run stage runs under (engine/market/runs.ts): the job
 * is awarded while its run prepares and installs, and moves to running only
 * when the agent starts work.
 */
export const RUN_STAGE_UNDER: Record<RunStage, JobStatus> = {
  preparing: 'awarded',
  installing: 'awarded',
  working: 'running',
  inspecting: 'inspecting',
  shipping: 'shipping',
  waiting: 'waiting',
  done: 'merged',
};

/** Inspection's checks, in the order they run. */
export const CHECKS = ['install', 'test', 'typecheck', 'lint', 'build', 'scope', 'review', 'design'] as const satisfies readonly CheckName[];
const checksComplete: Complete<Exclude<CheckName, (typeof CHECKS)[number]>> = true;

export const CHECK_LABEL: Record<CheckName, string> = {
  install: 'Install',
  test: 'Tests, and no fewer than before',
  typecheck: 'Type check',
  lint: 'Lint',
  build: 'Build',
  scope: 'The diff inside the job’s scope',
  review: 'A reviewer from another firm',
  design: 'Before and after against the design bar',
};

export const CHECK_STATUSES = ['pass', 'fail', 'skipped', 'preexisting'] as const satisfies readonly CheckStatus[];
const checkStatusesComplete: Complete<Exclude<CheckStatus, (typeof CHECK_STATUSES)[number]>> = true;

export const CHECK_STATUS_LABEL: Record<CheckStatus, string> = {
  pass: 'Pass',
  fail: 'Fail',
  skipped: 'Skipped when the repo has no such check, never a pass',
  preexisting: 'Already failing before the change: not held against it',
};

/** A floor earned in the market. */
export const FLOOR_STATES = ['waiting', 'lit', 'scar'] as const satisfies readonly EarnedFloor['state'][];
const floorStatesComplete: Complete<Exclude<EarnedFloor['state'], (typeof FLOOR_STATES)[number]>> = true;

export const FLOOR_STATE_LABEL: Record<EarnedFloor['state'], string> = {
  waiting: 'Cured and dark, waiting for his merge',
  lit: 'Lit on merge, and the firm is paid',
  scar: 'Struck to a scar, a work lamp left burning',
};

/** Every legal move, as `from>to` pairs, from the code's own table. */
export function legalMoves(): Array<[JobStatus, JobStatus]> {
  return (Object.keys(LEGAL_MOVES) as JobStatus[]).flatMap((from) => LEGAL_MOVES[from].map((to): [JobStatus, JobStatus] => [from, to]));
}

/**
 * Why a job goes back to open from each state (the comments on LEGAL_MOVES).
 * Keyed by move: the test fails if a note names a move the table no longer has.
 */
export const REOPEN_NOTES: Partial<Record<`${JobStatus}>${JobStatus}`, string>> = {
  'bidding>open': 'No positive bid in the window',
  'awarded>open': 'Killed before it started',
  'running>open': 'Killed, no attempt spent',
  'inspecting>open': 'Killed mid-inspection',
  'shipping>open': 'Push refused twice, no scar',
  'failed>open': `While attempts are under ${MAX_ATTEMPTS}`,
  'halted>open': 'Resumed',
};

/** The two ways a passing change ships (ruling 23): both are legal moves out of shipping. */
export const SHIP_MODES = [
  { move: 'shipping>waiting', label: 'Pull request mode', note: 'Opens a pull request and waits for his merge' },
  { move: 'shipping>merged', label: 'Push mode', note: 'Merges in a fresh clone, runs the checks again, fast-forwards' },
] as const satisfies ReadonlyArray<{ move: `${JobStatus}>${JobStatus}`; label: string; note: string }>;

export const AWARD_RULE = `The chance of passing, as the city reckons it from the firm’s record, times the job’s worth of ${TIER_VALUE.low}, ${TIER_VALUE.normal} or ${TIER_VALUE.high} by its tier, less the bid’s price`;

// ---------------------------------------------------------------- the sandbox

/** The egress proxy's stages, in the order a run reaches them. */
export const EGRESS_STAGES = ['install', 'working', 'checks'] as const satisfies readonly EgressStage[];
const egressComplete: Complete<Exclude<EgressStage, (typeof EGRESS_STAGES)[number]>> = true;

export const EGRESS_STAGE_LABEL: Record<EgressStage, string> = {
  install: 'Install',
  working: 'Working',
  checks: 'Checks',
};

/** The example the egress table is drawn for: an npm repo and a Claude agent. */
export const EGRESS_EXAMPLE = { ecosystems: ['npm'] as Array<keyof typeof REGISTRY_HOSTS>, model: 'claude:sonnet' };

/** The hosts each stage allows for the example, computed by the proxy's own rule. */
export function egressHosts(): Record<EgressStage, string[]> {
  const out = {} as Record<EgressStage, string[]>;
  for (const s of EGRESS_STAGES) out[s] = hostsFor(s, EGRESS_EXAMPLE.ecosystems, EGRESS_EXAMPLE.model);
  return out;
}

/** The guard's refusals, as short labels: a reason added to the guard and not named here fails the typecheck. */
export const GUARD_LABEL: Record<keyof typeof FORBIDDEN_REASONS, string | null> = {
  push: 'Any push',
  remote: 'Changing the remotes',
  config: 'Changing the git config',
  rewrite: 'Rewriting history',
  resetRemote: 'Resetting to a remote branch',
  rebaseRemote: 'Rebasing onto a remote branch',
  branchDelete: 'Deleting a branch the city did not make',
  tagDelete: 'Deleting a tag',
  gh: 'The GitHub CLI',
  rmOutside: 'Recursive removal outside the repo',
  privileged: 'sudo, launchctl, osascript, security',
  pipeShell: 'A download piped into a shell',
  gitDir: 'Writing the repo’s .git',
  credentials: 'Naming a credential file',
  reservedPort: 'Reaching the engine, Ollama, other runs',
  unreadable: 'Anything it cannot read',
  // The file tools' path rules: drawn as one line.
  pathOutside: 'A file path outside the repo',
  pathGit: null,
  pathSymlink: null,
  pathHardlink: null,
  pathBad: null,
  pathUnresolved: null,
};

/** The credential paths both agent profiles deny by name, with Claude's own configuration. */
export const SECRETS = [...SECRET_PATHS.map((p) => `~/${p}`), '~/.claude', '~/.claude.json'];

/** The never list, read from the personas every agent is seeded with; the personas must agree. */
export function neverList(): string[] {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'engine', 'market', 'personas');
  const lines = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const m = /^Never without asking:\s*(.+?)\.?\s*$/m.exec(readFileSync(join(dir, f), 'utf8'));
    if (!m) throw new Error(`The persona ${f} carries no never list`);
    lines.add(m[1]);
  }
  if (lines.size !== 1) throw new Error(`The personas disagree on the never list: ${[...lines].join(' | ')}`);
  const [line] = [...lines];
  return line.split(/,\s*(?![^,]*\bor\b)/).map((s) => s.trim()).filter(Boolean).map((s) => s[0].toUpperCase() + s.slice(1));
}

// ---------------------------------------------------------------- the school

/** The nets the school trains, then the master. */
export const NETS = ['appraiser-pass', 'appraiser-cost', 'router', 'durability', 'triage', 'taste', 'master'] as const satisfies readonly NetName[];
const netsComplete: Complete<Exclude<NetName, (typeof NETS)[number]>> = true;

export const NET_LABEL: Record<NetName, { name: string; learns: string }> = {
  'appraiser-pass': { name: 'Appraiser', learns: 'Will this job pass' },
  'appraiser-cost': { name: 'Appraiser’s cost head', learns: 'What it will cost' },
  router: { name: 'Router', learns: 'Which agent suits it' },
  durability: { name: 'Durability', learns: 'Which merges survive' },
  triage: { name: 'Triage', learns: 'Which brief items he acts on' },
  taste: { name: 'Taste', learns: 'His design bar' },
  master: { name: 'The master', learns: 'Would he approve this' },
};

export const WORK_KIND_LABEL: Record<WorkKind, string> = {
  'propose:harness': 'Harness proposals',
  'propose:readme-gap': 'README gap proposals',
  'merge:low': 'Low tier merges',
  'merge:normal': 'Normal tier merges',
  'merge:high': 'High tier merges',
  'merge:ui': 'UI merges',
};

/**
 * The autonomy chain, as the ledger records it: the master's prediction,
 * his decision, then every autonomy kind. The test fails if the ledger gains
 * an autonomy kind this chain does not draw.
 */
export const AUTONOMY_CHAIN = [
  'master.predicted',
  'decision.resolved',
  'autonomy.asked',
  'autonomy.granted',
  'autonomy.declined',
  'autonomy.acted',
  'autonomy.suspended',
  'autonomy.revoked',
] as const satisfies readonly LedgerKind[];

export const AUTONOMY_LABEL: Record<(typeof AUTONOMY_CHAIN)[number], { name: string; note: string }> = {
  'master.predicted': { name: 'The master’s guess', note: 'Written when a job is proposed or a pull request opens, before he decides' },
  'decision.resolved': { name: 'His decision', note: 'Posting or dismissing a proposal, merging or closing a pull request. A revert is a no, and the city’s own acts never count' },
  'autonomy.asked': { name: 'The city asks', note: 'In his brief: one kind of work, on one repo' },
  'autonomy.granted': { name: 'Granted', note: 'Only his answer grants it' },
  'autonomy.declined': { name: 'Not yet', note: `Quiet for ${AGREE.quietDays} days` },
  'autonomy.acted': { name: 'The city acts', note: `Only while the grant stands and the master is trusted, current and sure at ${AGREE.actP} or more` },
  'autonomy.suspended': { name: 'Suspended', note: 'When he undoes something it did' },
  'autonomy.revoked': { name: 'Revoked', note: 'By a revert of a merge it made' },
};

/** Every autonomy kind the ledger knows, for the drift test. */
export const LEDGER_AUTONOMY_KINDS = LEDGER_KINDS.filter((k) => k.startsWith('autonomy.'));

/** The school's numbers, as the diagram words them. */
export const SCHOOL_WORDS = {
  rows: `The newest ${Math.round(HELD_OUT * 100)}% held out for scoring; at least ${NET_MIN.train} to train on and ${NET_MIN.heldOut} to test`,
  agreement: `The master agreed with him on ${Math.round(AGREE.rate * 100)}% of his last ${AGREE.window} decisions of a kind, across every repo; and the repo has ${AGREE.repoMin} of its own, none of its last ${AGREE.repoLast} against`,
  act: `Only while the master is trusted, no older than ${AGREE.staleDays} days, and says ${AGREE.actP} or more`,
  quiet: `Quiet for ${AGREE.quietDays} days`,
  arena: `An arena: up to ${ARENA.keepPlanted} planted bugs and ${ARENA.keepPast} past changes, split into breeding, race and sealed tasks`,
  voyage: `A voyage: ${VOYAGE.population} designs, ${VOYAGE.generations} generations, local models only`,
  lora: `A LoRA on verified work, from ${LORA.min} examples`,
  sealed: `Against its base model, or the seeded agents, on tasks kept out of all learning; ${SEALED_USES} races to a sealed set`,
  graduate: 'What wins its race joins the roster, and a firm can hire it',
} as const;

// The exhaustiveness flags are read here so the compiler keeps every one.
export const COMPLETE = [jobStatesComplete, jobSplitComplete, runStagesComplete, checksComplete, checkStatusesComplete, floorStatesComplete, egressComplete, netsComplete] as const;
