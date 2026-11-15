/**
 * The LoRA dataset (Phase 4 ruling 23, Task 24): his verified past work as
 * fine-tuning examples, in the arena's chat shape.
 *
 * Each verified change (`verifiedChanges`, Task 18) of every connected repo
 * becomes one chat, exactly as Beagle's runner would hold it for a racer on
 * a past-change arena (`toBeagleArena`, Task 21):
 *
 * - system: the arena's description, the genome instructions (none here),
 *   "Reply with JSON only." and the tool and answer shapes, as Beagle's
 *   `system()` writes them;
 * - user: what the change was asked to do (its commit or PR message, with
 *   merge subjects and trailers dropped) and the diff of the tests it added
 *   or changed, if any;
 * - for each source file it edits: an assistant `read_file` call and the
 *   user turn with its result, as the arena's read_file returns it (numbered
 *   lines, at most 400 at once);
 * - assistant: `{"action":"answer","answer":{"edits":[...]}}`, the edits
 *   built from the change's hunks by `hunksToEdits`.
 *
 * Only source files the arena would let a racer edit are in the answer;
 * test files are shown as the tests' diff, never edited, and other files
 * are left out. A file that is a link or a submodule on either side is
 * skipped and never read (git reads blobs by id, never a path in a tree).
 *
 * Skipped, by reason:
 * - `sealed`: its ref, its sha or any commit it brought in
 *   (`git rev-list parent..sha`) is in `sealedRefs()` (Task 20, ruling 25);
 * - `too-large`: a regular file of the change is over LORA.maxFileBytes on
 *   either side;
 * - `too-long`: the example is over LORA.maxSeq tokens by `estimateTokens`,
 *   or needs more edits than an answer may hold;
 * - `not-unique`: its hunks cannot be written as find-and-replace edits
 *   (a source file created or removed, or a find that stays repeated);
 * - `no-edit`: it changed no source file a racer may edit;
 * - `secret`: it touches a file that holds credentials by its name
 *   (`secretPath`), or anything in the example is something `redact()`
 *   would change (a token, a key, a path of this Mac). The whole example
 *   is dropped rather than redacted, so its edits stay exact.
 *
 * Every git read is on the bare mirror through getRunner() with
 * ENGINE_GIT_FLAGS, argv only, and every sha and blob id is checked as 40
 * hex first. The data is written only under `paths().school/lora/data`:
 * `train.jsonl` and `valid.jsonl`, the newest 10% (rounded, at least one)
 * held for validation.
 *
 * The data contract the trainer reads (Task 25, `mlx_lm.lora --data`):
 * each line of either file is `{"messages":[{"role","content"},...]}`,
 * roles `system`, `user` and `assistant`. With `--mask-prompt`, mlx-lm
 * trains only on the last message (the answer); the read_file turns are
 * context. Lines are oldest first. Nothing in the files names a path of
 * this Mac.
 */
import { randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { GATE, LORA, SEALED_USES, VOYAGE } from '../../shared/school-rules.js';
import type { ArenaInfo, Graduate, Interval, Repo, TrainState } from '../../shared/types.js';
import { openDb } from '../db.js';
import { emit } from '../events.js';
import { getRunner, getSpawner, type SpawnLine } from '../exec.js';
import { paths } from '../home.js';
import { record } from '../ledger.js';
import { creditEntries } from '../market/budget.js';
import { agent as storedAgent } from '../market/firms.js';
import { mirrorDir } from '../mirror.js';
import { refusedHosts, startEgress, type Egress } from '../market/egress.js';
import { redact } from '../market/jobs.js';
import type { RunLogLine } from '../market/provider.js';
import { SECRET_PATHS, wrap } from '../market/sandbox.js';
import { getSettings, patchSettings } from '../settings.js';
import { ENGINE_GIT_FLAGS } from '../market/worktree.js';
import { listRepos } from '../repos.js';
import { arenaInfo, listArenas, protectedReason, registerArenas, sealedRefs, toBeagleArena, type ArenaEdit } from './arenas.js';
import type { BeagleApi, BeagleDriver, BeagleGenome } from './beagle-api.js';
import { loadBeagle, schoolDriver, useDriver } from './beagle.js';
import { isSourceFile, verifiedChanges, type VerifiedChange } from './history.js';
import { ci, pairedCi } from './stats.js';
import { registerAbort, TURNED_OFF_REASON } from './tick.js';
import { holdTrain, liveTrains, readGate, startTrain } from './trainer.js';
import { TRAINER_DIR, trainerEnv, trainerPython } from './trainer-env.js';

export type LoraSkip = 'sealed' | 'secret' | 'too-large' | 'too-long' | 'not-unique' | 'no-edit';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LoraExample {
  repo: string;
  /** History's ref: `pr:<n>`, `commit:<sha>` or `city:<jobId>`. */
  ref: string;
  sha: string;
  at: string;
  tokens: number;
  messages: ChatMessage[];
}

export interface LoraData {
  /** Every example, oldest first (train then valid). */
  examples: LoraExample[];
  skipped: Record<LoraSkip, number>;
  /** `train.jsonl`. */
  path: string;
  /** `valid.jsonl`. */
  validPath: string;
  /** Repos whose history could not be read this time, with why. */
  failed: Record<string, string>;
}

const SHA = /^[0-9a-f]{40}$/;
const GIT_MS = 120_000;
/** The arena's read_file shows at most this many lines at once. */
const READ_LINES = 400;
/** The arena's applyEdits takes at most this many edits. */
const MAX_EDITS = 50;
/** The arena caps a past task's test diff at this many characters. */
const MAX_TEST_DIFF = 24_000;
/** The share of the newest examples held for validation. */
const VALID_SHARE = 0.1;
/** Bytes per token, on the low side for a code tokenizer, so the estimate errs long. */
const BYTES_PER_TOKEN = 3;
/** A chat template's own tokens around each message (role markers and separators). */
const TOKENS_PER_MESSAGE = 6;

// ---------------------------------------------------------------- hunks to edits

interface Hunk {
  /** The old range in the before text's lines, [s, e). */
  s: number;
  e: number;
  /** What replaces it. */
  text: string;
}

/** A text's lines, each with its own newline (the last one may have none). */
function linesOf(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function occurrences(text: string, find: string): number {
  return find === '' ? Infinity : text.split(find).length - 1;
}

interface ParsedHunk {
  start: number;
  count: number;
  newCount: number;
  old: string[];
  neu: string[];
}

/** The hunks of a unified diff of one file, or null when it does not parse. */
function parseHunks(patch: string): ParsedHunk[] | null {
  const out: ParsedHunk[] = [];
  /** The hunk whose lines are being read; null outside a hunk. */
  let cur: ParsedHunk | null = null;
  /** The hunk and side the last line went to, for a "no newline" marker. */
  let last: { h: ParsedHunk; side: 'old' | 'neu' | 'both' } | null = null;
  const strip = (a: string[]) => {
    if (a.length) a[a.length - 1] = a[a.length - 1].replace(/\n$/, '');
  };
  for (const line of patch.split('\n')) {
    const head = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (head) {
      if (cur) return null;
      cur = { start: Number(head[1]), count: head[2] === undefined ? 1 : Number(head[2]), newCount: head[3] === undefined ? 1 : Number(head[3]), old: [], neu: [] };
      out.push(cur);
      last = null;
      if (cur.count === 0 && cur.newCount === 0) cur = null;
      continue;
    }
    if (line.startsWith('\\')) {
      if (last && last.side !== 'neu') strip(last.h.old);
      if (last && last.side !== 'old') strip(last.h.neu);
      continue;
    }
    if (!cur) continue;
    const body = `${line.slice(1)}\n`;
    if (line.startsWith(' ')) {
      cur.old.push(body);
      cur.neu.push(body);
      last = { h: cur, side: 'both' };
    } else if (line.startsWith('-')) {
      cur.old.push(body);
      last = { h: cur, side: 'old' };
    } else if (line.startsWith('+')) {
      cur.neu.push(body);
      last = { h: cur, side: 'neu' };
    } else {
      return null;
    }
    if (cur.old.length > cur.count || cur.neu.length > cur.newCount) return null;
    if (cur.old.length === cur.count && cur.neu.length === cur.newCount) cur = null;
  }
  if (cur) return null;
  return out;
}

/**
 * The find-and-replace edits that turn `before` into what `patch` (a
 * unified diff of that one file) makes of it: each hunk's old lines, widened
 * by the lines around them until the text appears exactly once in `before`,
 * replaced by its new lines. Hunks whose widened ranges overlap become one
 * edit. Applied in order the arena's way (each find exactly once in the
 * text so far, replaced whole), they reproduce the after text; null when
 * they cannot (an empty before text, a patch that does not fit it, or a
 * find that stays repeated).
 */
export function hunksToEdits(before: string, patch: string): Array<{ find: string; replace: string }> | null {
  const hunks = parseHunks(patch);
  const lines = linesOf(before);
  if (!hunks || !hunks.length || !lines.length) return null;
  const join_ = (s: number, e: number) => lines.slice(s, e).join('');

  // Each hunk's place in the before text, checked against its old lines.
  const placed: Hunk[] = [];
  for (const h of hunks) {
    const s = h.count === 0 ? h.start : h.start - 1;
    const e = s + h.count;
    if (s < 0 || e > lines.length || join_(s, e) !== h.old.join('')) return null;
    if (placed.length && s < placed[placed.length - 1].e) return null;
    placed.push({ s, e, text: h.neu.join('') });
  }

  // The after text, from the hunks alone.
  let after = '';
  let at = 0;
  for (const h of placed) {
    after += join_(at, h.s) + h.text;
    at = h.e;
  }
  after += join_(at, lines.length);

  // Widen each hunk's range until its text is unique, then merge overlaps.
  const ranges: Array<{ s: number; e: number; hunks: Hunk[] }> = [];
  for (const h of placed) {
    let s = h.s;
    let e = h.e;
    let up = true;
    while (occurrences(before, join_(s, e)) !== 1) {
      if (s === 0 && e === lines.length) return null;
      if ((up && s > 0) || e === lines.length) s--;
      else e++;
      up = !up;
    }
    ranges.push({ s, e, hunks: [h] });
    // A widened range that reaches back into earlier ones takes them in.
    while (ranges.length > 1 && ranges[ranges.length - 1].s < ranges[ranges.length - 2].e) {
      const b = ranges.pop()!;
      const a = ranges[ranges.length - 1];
      a.s = Math.min(a.s, b.s);
      a.e = Math.max(a.e, b.e);
      a.hunks.push(...b.hunks);
    }
  }

  const edits = ranges.map((r) => {
    let replace = '';
    let i = r.s;
    for (const h of r.hunks) {
      replace += join_(i, h.s) + h.text;
      i = h.e;
    }
    replace += join_(i, r.e);
    return { find: join_(r.s, r.e), replace };
  });

  // Applied in order, as the arena applies them, they must give the after text.
  let text = before;
  for (const e of edits) {
    if (occurrences(text, e.find) !== 1) return null;
    text = text.replace(e.find, () => e.replace);
  }
  return text === after ? edits : null;
}

// ---------------------------------------------------------------- secrets

/** File names that hold credentials, wherever they sit in a repo. */
const SECRET_NAMES = [/^\.env/i, /\.pem$/i, /\.key$/i, /^id_rsa/i, /^credentials/i, /^secrets/i, /\.p12$/i];

/**
 * Whether a repo path names a credentials file: one of SECRET_NAMES, or any
 * of the sandbox's SECRET_PATHS (`.ssh`, `.aws`, `.gnupg`, `.config/gh`,
 * `.npmrc`, `.netrc`, `.git-credentials` and the rest) as its own run of
 * path segments anywhere in it. Case is ignored, as APFS ignores it.
 */
export function secretPath(path: string): boolean {
  const segs = path.toLowerCase().split('/');
  const name = segs[segs.length - 1] ?? '';
  if (SECRET_NAMES.some((re) => re.test(name))) return true;
  for (const p of SECRET_PATHS) {
    const want = p.toLowerCase().split('/');
    for (let i = 0; i + want.length <= segs.length; i++) {
      if (want.every((w, j) => segs[i + j] === w)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------- tokens

/**
 * The tokens an example takes, estimated on the long side (no tokenizer is
 * loaded in the engine): its UTF-8 bytes over BYTES_PER_TOKEN, plus the
 * chat template's own tokens per message.
 */
export function estimateTokens(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += Math.ceil(Buffer.byteLength(m.content, 'utf8') / BYTES_PER_TOKEN) + TOKENS_PER_MESSAGE;
  return n;
}

// ---------------------------------------------------------------- git

async function mirrorGit(repo: Repo, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return getRunner()('git', [...ENGINE_GIT_FLAGS, '-C', mirrorDir(repo.fullName), ...args], { timeoutMs: GIT_MS });
}

interface RawEntry {
  path: string;
  oldMode: string;
  newMode: string;
  oldBlob: string;
  newBlob: string;
  status: string;
}

const ZERO = '0'.repeat(40);
const REGULAR = new Set(['100644', '100755']);

/** `git diff --raw` between parent and sha: every changed path with its modes and blob ids. */
async function rawDiff(repo: Repo, parent: string, sha: string): Promise<RawEntry[] | null> {
  const r = await mirrorGit(repo, ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', '--no-textconv', parent, sha]);
  if (r.code !== 0) return null;
  const parts = r.stdout.split('\0');
  const out: RawEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])\d*$/.exec(parts[i]);
    if (!m) return null;
    out.push({ oldMode: m[1], newMode: m[2], oldBlob: m[3], newBlob: m[4], status: m[5], path: parts[i + 1] });
  }
  return out;
}

async function blobSize(repo: Repo, blob: string): Promise<number | null> {
  if (!SHA.test(blob) || blob === ZERO) return 0;
  const r = await mirrorGit(repo, ['cat-file', '-s', blob]);
  const n = Number(r.stdout.trim());
  return r.code === 0 && Number.isFinite(n) ? n : null;
}

/** A blob's text, or null when it cannot be read or is not text. */
async function blobText(repo: Repo, blob: string): Promise<string | null> {
  if (!SHA.test(blob)) return null;
  if (blob === ZERO) return '';
  const r = await mirrorGit(repo, ['cat-file', 'blob', blob]);
  if (r.code !== 0 || r.stdout.includes('\0') || r.stdout.includes('�')) return null;
  return r.stdout;
}

/** The unified diff between two blobs (git diff of blob ids, never a path). */
async function blobDiff(repo: Repo, a: string, b: string): Promise<string | null> {
  if (!SHA.test(a) || !SHA.test(b)) return null;
  const r = await mirrorGit(repo, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '-U3', a, b]);
  return r.code === 0 || r.code === 1 ? r.stdout : null;
}

/** Every commit the change brought in, or null when it cannot be read. */
async function commitsOf(repo: Repo, c: VerifiedChange): Promise<string[] | null> {
  if (!SHA.test(c.sha)) return null;
  if (!SHA.test(c.parent)) return [c.sha];
  const r = await mirrorGit(repo, ['rev-list', `${c.parent}..${c.sha}`]);
  if (r.code !== 0) return null;
  return r.stdout.split('\n').filter((l) => SHA.test(l));
}

/** What the change was asked to do: its message with merge subjects and trailers dropped. */
async function requestOf(repo: Repo, c: VerifiedChange): Promise<string> {
  const r = await mirrorGit(repo, ['show', '-s', '--format=%B', c.sha]);
  const lines = r.code === 0 ? r.stdout.replace(/\r/g, '').split('\n') : [];
  if (lines.length && /^Merge (pull request|branch|remote-tracking branch) /.test(lines[0])) lines.shift();
  while (lines.length && (lines[lines.length - 1].trim() === '' || /^[A-Za-z][A-Za-z-]*: \S/.test(lines[lines.length - 1]))) lines.pop();
  const text = lines.join('\n').trim();
  return text || 'A change to the source.';
}

// ---------------------------------------------------------------- one example

type Built = { example: LoraExample } | { skip: LoraSkip } | { error: string };

/** The read_file call and result turns for one file, as the arena's read_file answers. */
function readTurns(file: string, text: string): ChatMessage[] {
  const lines = text.split('\n');
  const out: ChatMessage[] = [];
  for (let from = 1; from <= lines.length; from += READ_LINES) {
    const to = Math.min(lines.length, from + READ_LINES - 1);
    const args = from === 1 ? { file } : { file, from, to };
    out.push({ role: 'assistant', content: JSON.stringify({ action: 'read_file', args }) });
    const result = { file, of: lines.length, lines: lines.slice(from - 1, to).map((l, i) => `${from + i}: ${l}`).join('\n') };
    out.push({ role: 'user', content: `Result of read_file: ${JSON.stringify(result)}` });
  }
  return out;
}

/** The system turn as Beagle's runner writes it, for a genome with every arena tool and no instructions. */
function systemOf(repo: Repo): string {
  const arena = toBeagleArena({ id: 'lora', repo: repo.fullName, kind: 'past' });
  const tools = arena.tools;
  return [
    arena.describe,
    '',
    '',
    '',
    'Reply with JSON only.',
    `To use a tool, reply {"action": "<tool name>", "args": {...}}. To answer, reply {"action": "answer", "answer": ${JSON.stringify(arena.answer)}}.\nTools:\n${tools.map((t) => `- ${t.name}: ${t.describe} Arguments: ${JSON.stringify(t.args)}`).join('\n')}`,
  ].join('\n');
}

async function exampleOf(repo: Repo, c: VerifiedChange, sealed: Set<string>, system: string): Promise<Built> {
  if (!SHA.test(c.sha) || !SHA.test(c.parent)) return { error: `${c.ref} has no readable parent` };
  if (sealed.has(c.ref) || sealed.has(c.sha)) return { skip: 'sealed' };
  const commits = await commitsOf(repo, c);
  if (!commits) return { error: `the commits of ${c.ref} could not be read` };
  if (commits.some((x) => sealed.has(x))) return { skip: 'sealed' };
  // A change that touches a credentials file is never read.
  if (c.files.some(secretPath)) return { skip: 'secret' };

  const raw = await rawDiff(repo, c.parent, c.sha);
  if (!raw) return { error: `the diff of ${c.ref} could not be read` };
  if (raw.some((f) => secretPath(f.path))) return { skip: 'secret' };
  // Links and submodules on either side are skipped, never read.
  const files = raw.filter((f) => (f.oldMode === '000000' || REGULAR.has(f.oldMode)) && (f.newMode === '000000' || REGULAR.has(f.newMode)));
  for (const f of files) {
    for (const blob of [f.oldBlob, f.newBlob]) {
      const n = await blobSize(repo, blob);
      if (n === null) return { error: `a file of ${c.ref} could not be read` };
      if (n > LORA.maxFileBytes) return { skip: 'too-large' };
    }
  }

  const command = repo.checks?.test ?? '';
  const tests = files.filter((f) => protectedReason(f.path, command) === 'the tests may not be changed');
  const sources = files.filter((f) => isSourceFile(f.path) && !protectedReason(f.path, command));
  if (!sources.length) return { skip: 'no-edit' };

  const reads: ChatMessage[] = [];
  const edits: ArenaEdit[] = [];
  for (const f of sources) {
    if (f.status !== 'M' || f.oldBlob === ZERO || f.newBlob === ZERO) return { skip: 'not-unique' };
    const before = await blobText(repo, f.oldBlob);
    const after = await blobText(repo, f.newBlob);
    const patch = await blobDiff(repo, f.oldBlob, f.newBlob);
    if (before === null || after === null || patch === null) return { error: `a file of ${c.ref} is not text or could not be read` };
    const got = hunksToEdits(before, patch);
    if (!got) return { skip: 'not-unique' };
    let check = before;
    for (const e of got) check = check.replace(e.find, () => e.replace);
    if (check !== after) return { skip: 'not-unique' };
    reads.push(...readTurns(f.path, before));
    edits.push(...got.map((e) => ({ file: f.path, find: e.find, replace: e.replace })));
  }
  if (edits.length > MAX_EDITS) return { skip: 'too-long' };

  const parts = [`A change to ${repo.fullName} was asked for:`, await requestOf(repo, c)];
  if (tests.length) {
    let diff = '';
    for (const f of tests) {
      const a = f.oldBlob === ZERO ? null : f.oldBlob;
      const b = f.newBlob === ZERO ? null : f.newBlob;
      const before = a ? await blobText(repo, a) : '';
      const after = b ? await blobText(repo, b) : '';
      if (before === null || after === null) return { error: `a test file of ${c.ref} is not text or could not be read` };
      diff += testDiff(f.path, before, after, a && b ? await blobDiff(repo, a, b) : null);
    }
    parts.push('', 'The tests it added or changed:', diff.length > MAX_TEST_DIFF ? diff.slice(0, MAX_TEST_DIFF) : diff);
  }
  parts.push('', 'Make the change to the source.');

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n') },
    ...reads,
    { role: 'assistant', content: JSON.stringify({ action: 'answer', answer: { edits } }) },
  ];
  // Anything redact() would touch keeps the whole example out; redacting it would break the edits.
  if (messages.some((m) => redact(m.content) !== m.content)) return { skip: 'secret' };
  const tokens = estimateTokens(messages);
  if (tokens > LORA.maxSeq) return { skip: 'too-long' };
  return { example: { repo: repo.fullName, ref: c.ref, sha: c.sha, at: c.at, tokens, messages } };
}

/** A test file's diff with its own name in the headers (blob diffs name the blobs). */
function testDiff(path: string, before: string, after: string, blobPatch: string | null): string {
  const head = `--- ${before ? `a/${path}` : '/dev/null'}\n+++ ${after ? `b/${path}` : '/dev/null'}\n`;
  if (blobPatch !== null) {
    const at = blobPatch.indexOf('\n@@');
    return head + (at >= 0 ? blobPatch.slice(at + 1) : '');
  }
  const lines = linesOf(before || after);
  const sign = before ? '-' : '+';
  const body = lines.map((l) => `${sign}${l.replace(/\n$/, '')}\n`).join('');
  return `${head}@@ ${before ? `-1,${lines.length} +0,0` : `-0,0 +1,${lines.length}`} @@\n${body}`;
}

// ---------------------------------------------------------------- the dataset

/** Where the dataset is written: `paths().school/lora/data`. */
export function loraDataDir(): string {
  return join(paths().school, 'lora', 'data');
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/**
 * Builds the LoRA dataset from every connected repo's verified changes
 * (ruling 23): one example per change in the arena's chat shape, never one
 * from a sealed set, and writes `train.jsonl` and `valid.jsonl` (the newest
 * 10%) under `paths().school/lora/data`. With `check`, history may run its
 * gated test checks first. A repo whose history cannot be read is named in
 * `failed` and adds nothing.
 */
export async function buildLoraData(now: number, o: { check?: boolean; signal?: AbortSignal } = {}): Promise<LoraData> {
  const skipped: Record<LoraSkip, number> = { sealed: 0, secret: 0, 'too-large': 0, 'too-long': 0, 'not-unique': 0, 'no-edit': 0 };
  const failed: Record<string, string> = {};
  const examples: LoraExample[] = [];
  const sealed = sealedRefs();
  for (const repo of listRepos()) {
    if (!repo.connected) continue;
    let changes: VerifiedChange[];
    try {
      changes = await verifiedChanges(repo, now, { check: o.check === true, signal: o.signal });
    } catch (err) {
      failed[repo.fullName] = (err as Error).message ?? String(err);
      continue;
    }
    const system = systemOf(repo);
    for (const c of changes) {
      if (o.signal?.aborted) break;
      const got = await exampleOf(repo, c, sealed, system);
      if ('example' in got) examples.push(got.example);
      else if ('skip' in got) skipped[got.skip]++;
      else failed[repo.fullName] = got.error;
    }
  }
  examples.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.sha.localeCompare(b.sha));

  const nValid = examples.length ? Math.max(1, Math.round(examples.length * VALID_SHARE)) : 0;
  const train = examples.slice(0, examples.length - nValid);
  const valid = examples.slice(examples.length - nValid);
  const dir = loraDataDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'train.jsonl');
  const validPath = join(dir, 'valid.jsonl');
  const jsonl = (list: LoraExample[]) => list.map((e) => `${JSON.stringify({ messages: e.messages })}\n`).join('');
  writeAtomic(path, jsonl(train));
  writeAtomic(validPath, jsonl(valid));
  return { examples, skipped, path, validPath, failed };
}

// ---------------------------------------------------------------- training (ruling 24)

/** Where the base model is downloaded to, and read from: `paths().school/lora/base`. */
export function loraBaseDir(): string {
  return join(paths().school, 'lora', 'base');
}

/** One LoRA's own folder: its adapter checkpoints and the copy of the data it trains on. */
function adapterDir(id: string): string {
  return join(paths().school, 'lora', 'adapters', id);
}

/** Where each LoRA's record is kept: under the school's ctl, which the trainer profile denies the trainer writing. */
function runsDir(): string {
  return join(paths().school, 'ctl', 'lora');
}

/** The checkpoint mlx-lm rewrites at each save and at the end, and that a resume loads. */
const ADAPTER_FILE = 'adapters.safetensors';

/** Bytes per element of each safetensors dtype. */
const DTYPE_BYTES: Record<string, number> = { BOOL: 1, U8: 1, I8: 1, F8_E4M3: 1, F8_E5M2: 1, I16: 2, U16: 2, F16: 2, BF16: 2, I32: 4, U32: 4, F32: 4, I64: 8, U64: 8, F64: 8 };
/** A header bigger than this is not one mlx-lm wrote. */
const MAX_HEADER = 100 * 1024 * 1024;

/**
 * Whether `path` is a whole safetensors file: an 8-byte little-endian
 * header length, a JSON header whose every tensor's size (dtype times
 * shape) is its byte range, the ranges packed from 0 with no gap or
 * overlap, and the file exactly as long as header and data. A write cut
 * short (mlx-lm writes the checkpoint in place) fails it.
 */
export function adapterIntact(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return false;
  }
  try {
    const size = fstatSync(fd).size;
    if (size < 8) return false;
    const lenBuf = Buffer.alloc(8);
    if (readSync(fd, lenBuf, 0, 8, 0) !== 8) return false;
    const n = lenBuf.readBigUInt64LE(0);
    if (n === 0n || n > BigInt(MAX_HEADER) || 8n + n > BigInt(size)) return false;
    const head = Buffer.alloc(Number(n));
    if (readSync(fd, head, 0, head.length, 8) !== head.length) return false;
    let header: unknown;
    try {
      header = JSON.parse(head.toString('utf8'));
    } catch {
      return false;
    }
    if (!header || typeof header !== 'object' || Array.isArray(header)) return false;
    const ranges: Array<[number, number]> = [];
    for (const [name, t] of Object.entries(header as Record<string, unknown>)) {
      if (name === '__metadata__') continue;
      const d = t as { dtype?: unknown; shape?: unknown; data_offsets?: unknown };
      const bytes = typeof d?.dtype === 'string' ? DTYPE_BYTES[d.dtype] : undefined;
      if (!bytes || !Array.isArray(d.shape) || !Array.isArray(d.data_offsets) || d.data_offsets.length !== 2) return false;
      if (!d.shape.every((x) => Number.isSafeInteger(x) && x >= 0)) return false;
      const [a, b] = d.data_offsets as unknown[];
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || (a as number) < 0 || (b as number) < (a as number)) return false;
      const want = (d.shape as number[]).reduce((p, x) => p * x, 1) * bytes;
      if ((b as number) - (a as number) !== want) return false;
      ranges.push([a as number, b as number]);
    }
    ranges.sort((x, y) => x[0] - y[0]);
    let end = 0;
    for (const [a, b] of ranges) {
      if (a !== end) return false;
      end = b;
    }
    return 8 + Number(n) + end === size;
  } finally {
    closeSync(fd);
  }
}

/** The engine's copy of a LoRA's last whole checkpoint, under ctl where the trainer cannot write. */
function goodCopy(id: string): string {
  return join(runsDir(), `${id}.good.safetensors`);
}
const LORA_ID = /^lora-[0-9a-f]{8}$/;

/**
 * One LoRA, from its first train to its last: what is on disk, every pause
 * and every resume. Written by the engine alone, so a crash of the engine
 * or the trainer leaves the last saved step known.
 */
export interface LoraRun {
  id: string;
  /** The base model's repo, as it was when this LoRA started. */
  base: string;
  /** `trained` only once every step is saved and the trainer answered ok: only then may it be evaluated. */
  status: 'training' | 'paused' | 'trained' | 'failed';
  reason: string | null;
  /** The steps a whole run takes (`LORA.iters`). */
  iters: number;
  /** The last step written to `adapters.safetensors`, from the trainer's `{"saved": step}` lines. */
  saved: number;
  examples: number;
  createdAt: string;
  endedAt: string | null;
  /** The trains (trainer.ts) this LoRA ran in, in order. */
  trains: string[];
  /** Every resume: weights only, so the optimiser state and the batch order restarted. */
  resumes: Array<{ at: string; from: number; iters: number; optimizerReset: true }>;
  pauses: Array<{ at: string; train: string; reason: string | null; done: number; saved: number; lost: number }>;
  /** The step of the engine's copy of the last whole checkpoint (`goodCopy`), or 0 when there is none. */
  good: number;
  /** Each resume that found `adapters.safetensors` torn and went back to the last whole copy, with the steps that cost. */
  torn: Array<{ at: string; saved: number; from: number; lost: number }>;
  /** True once any resume happened: the result is not the same as an uninterrupted run, and the card says so. */
  optimizerReset: boolean;
  /**
   * The sealed splits its data was built without (ruling 25): each arena whose
   * sealed tasks were in `sealedRefs()` when the data was built, with its
   * sealed hash then. Only these arenas, unchanged, may score it (Task 27).
   */
  sealedArenas?: Record<string, string>;
  /** Every sealed race it was scored in against its base, oldest first (Task 27). */
  evaluations?: LoraEvaluation[];
  /** Why the tick no longer races it on its own (two races stopped before they finished), until he asks; null otherwise. */
  evaluationHeld?: string | null;
  /** When he last asked for it to be raced again: only stops after this count towards the hold. */
  evaluationAskedAt?: string | null;
}

function writeRun(run: LoraRun): void {
  mkdirSync(runsDir(), { recursive: true });
  writeAtomic(join(runsDir(), `${run.id}.json`), JSON.stringify(run, null, 2) + '\n');
}

/** Every LoRA recorded, oldest first. */
export function loraRuns(): LoraRun[] {
  let names: string[];
  try {
    names = readdirSync(runsDir());
  } catch {
    return [];
  }
  const out: LoraRun[] = [];
  for (const n of names) {
    if (!n.endsWith('.json') || !LORA_ID.test(n.slice(0, -5))) continue;
    try {
      const r = JSON.parse(readFileSync(join(runsDir(), n), 'utf8')) as LoraRun;
      if (r && r.id === n.slice(0, -5)) out.push(r);
    } catch {
      // a record that cannot be read is left out, never guessed at
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

/**
 * The newest fully trained adapter, or null; with `id`, that LoRA alone, and
 * only when it is trained. A paused, training or failed LoRA is never
 * offered, whatever its `adapters.safetensors` holds: a half-trained adapter
 * is never evaluated (Review Focus 1) nor served (ruling 26).
 */
export function trainedAdapter(id?: string): { id: string; path: string; file: string } | null {
  const run = loraRuns().filter((r) => r.status === 'trained' && (id === undefined || r.id === id)).at(-1);
  if (!run) return null;
  const path = adapterDir(run.id);
  const file = join(path, ADAPTER_FILE);
  return adapterIntact(file) ? { id: run.id, path, file } : null;
}

/** The base is ready when the setting says so and its files are there. */
export function baseReady(): boolean {
  return getSettings().school.baseModelReady === true && existsSync(join(loraBaseDir(), 'config.json'));
}

/** Ruling 24's argv for `mlx_lm.lora`, as `lora_train` passes it on: the full run, or the remaining steps from the checkpoint. */
export function loraArgs(o: { dir: string; iters: number; resume: boolean }): string[] {
  const args = [
    '--model', loraBaseDir(),
    '--train',
    '--data', join(o.dir, 'data'),
    '--fine-tune-type', 'lora',
    '--num-layers', String(LORA.layers),
    '--batch-size', String(LORA.batch),
    '--iters', String(o.iters),
    '--learning-rate', LORA.lr.toExponential(),
    '--max-seq-length', String(LORA.maxSeq),
    '--mask-prompt',
    '--grad-checkpoint',
    '--save-every', String(LORA.saveEvery),
    '--adapter-path', o.dir,
  ];
  if (o.resume) args.push('--resume-adapter-file', join(o.dir, ADAPTER_FILE));
  return args;
}

type DataBuilder = (now: number, o: { check?: boolean; signal?: AbortSignal }) => Promise<LoraData>;
let dataBuilder: DataBuilder = buildLoraData;

/** Installs the dataset builder for tests, or `null` for `buildLoraData`. */
export function setLoraDataBuilder(fn: DataBuilder | null): void {
  dataBuilder = fn ?? buildLoraData;
}

export interface LoraTrainResult {
  /** `refused`: no base or too few examples; `waiting`: the gate or the switch said no, nothing started. */
  status: 'refused' | 'waiting' | 'paused' | 'trained' | 'failed';
  reason: string | null;
  lora: LoraRun | null;
  train: TrainState | null;
}

let training = false;

/**
 * Trains the school's LoRA (ruling 24) one night's stretch at a time,
 * behind the heavy gate. Refused without the base model, or under
 * `LORA.min` examples ("n of 100 verified changes"). A new LoRA builds the
 * dataset with history's gated test checks on (`check: true`) and keeps its
 * own copy of it, so every resume trains on the same examples. A LoRA that
 * a pause stopped resumes from `adapters.safetensors` with `--iters` the
 * remaining steps; that loads the weights only, so the optimiser state and
 * the batch order restart, and the resume is recorded with
 * `optimizerReset: true`. It is `trained` only when every step is saved and
 * the trainer answered ok; a trained LoRA is not trained again.
 */
export async function trainLora(now: number = Date.now()): Promise<LoraTrainResult> {
  const answer = (status: LoraTrainResult['status'], reason: string | null, lora: LoraRun | null = null, train: TrainState | null = null): LoraTrainResult => ({ status, reason, lora, train });
  if (!baseReady()) return answer('refused', 'The base model is not downloaded');
  if (training) return answer('waiting', 'a LoRA is already training');
  training = true;
  try {
    let run = loraRuns().filter((r) => r.status !== 'failed').at(-1) ?? null;
    if (run?.status === 'trained') return answer('trained', null, run);
    // nothing is built or started for a train the switch or the gate would refuse now
    if (!getSettings().school.enabled) return answer('waiting', 'the school is off', run);
    if (!trainerPython()) return answer('failed', 'The trainer is not set up on this Mac', run);
    const g = await readGate('heavy', now);
    if (!g.ok) return answer('waiting', g.reason ?? 'the gate closed', run);

    if (!run) {
      // the sealed splits the data is about to be built without: only these may ever score this adapter
      const sealedArenas = heldOutSplits();
      const data = await dataBuilder(now, { check: true });
      const n = data.examples.length;
      // LORA.min also keeps valid.jsonl (the newest 10%) at 10 or more, never under the batch mlx-lm needs
      if (n < LORA.min) return answer('refused', `${n} of ${LORA.min} verified changes`);
      run = {
        id: `lora-${randomUUID().slice(0, 8)}`,
        base: getSettings().school.baseModel,
        status: 'training',
        reason: null,
        iters: LORA.iters,
        saved: 0,
        examples: n,
        createdAt: new Date(now).toISOString(),
        endedAt: null,
        trains: [],
        resumes: [],
        pauses: [],
        good: 0,
        torn: [],
        optimizerReset: false,
        sealedArenas,
        evaluations: [],
      };
      const dir = adapterDir(run.id);
      mkdirSync(join(dir, 'data'), { recursive: true });
      copyFileSync(data.path, join(dir, 'data', 'train.jsonl'));
      copyFileSync(data.validPath, join(dir, 'data', 'valid.jsonl'));
      writeRun(run);
    }
    const dir = adapterDir(run.id);
    // Records from before the last-good copy existed
    run.good ??= 0;
    run.torn ??= [];
    // A checkpoint is resumed from only when it is whole. A torn one goes back to the engine's last whole
    // copy and its step, the difference counted as lost; with no whole copy it starts again from 0.
    if (run.saved > 0 && !adapterIntact(join(dir, ADAPTER_FILE))) {
      const back = run.good > 0 && run.good <= run.saved && adapterIntact(goodCopy(run.id)) ? run.good : 0;
      if (back > 0) copyFileSync(goodCopy(run.id), join(dir, ADAPTER_FILE));
      run.torn.push({ at: new Date(now).toISOString(), saved: run.saved, from: back, lost: run.saved - back });
      run.saved = back;
      writeRun(run);
    }
    const from = Math.min(run.saved, run.iters);
    const iters = run.iters - from;
    const resumed = from > 0;
    const before = { status: run.status, reason: run.reason, resumes: [...run.resumes], optimizerReset: run.optimizerReset };
    const resume = { at: new Date(now).toISOString(), from, iters, optimizerReset: true as const };
    if (resumed) {
      run.resumes.push(resume);
      run.optimizerReset = true;
    }
    run.status = 'training';
    run.reason = null;
    writeRun(run);

    const current = run;
    let reply: { ok: boolean; error?: string } | null = null;
    const onLine = (line: SpawnLine) => {
      if (line.stream !== 'stdout' || !line.line.startsWith('{')) return;
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(line.line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!d || typeof d !== 'object') return;
      if (typeof d.saved === 'number' && Number.isInteger(d.saved) && d.saved > current.saved) {
        current.saved = Math.min(d.saved, current.iters);
        // the checkpoint was written before its saved line: a whole one becomes the last good copy
        const file = join(dir, ADAPTER_FILE);
        if (adapterIntact(file)) {
          try {
            mkdirSync(runsDir(), { recursive: true });
            copyFileSync(file, `${goodCopy(current.id)}.tmp`);
            if (adapterIntact(`${goodCopy(current.id)}.tmp`)) {
              renameSync(`${goodCopy(current.id)}.tmp`, goodCopy(current.id));
              current.good = current.saved;
            }
          } catch (err) {
            console.error('palimpsest: the LoRA checkpoint could not be copied:', err);
          }
        }
        writeRun(current);
      }
      if (typeof d.ok === 'boolean') reply = { ok: d.ok, error: typeof d.error === 'string' ? d.error : undefined };
    };
    const state = await startTrain({
      kind: 'lora',
      gate: 'heavy',
      command: { id: 1, cmd: 'lora_train', args: loraArgs({ dir, iters, resume: resumed }), start: from, of: run.iters },
      gb: LORA.gb,
      onLine,
      now,
      resumeFrom: from,
      extra: { lora: { id: run.id, from, iters, optimizerReset: resumed } },
    });

    if (state.status === 'waiting' || (state.status === 'failed' && state.endedAt === null)) {
      // nothing started: the run is as it was
      Object.assign(run, before);
      writeRun(run);
      return answer(state.status, state.reason, run, state);
    }
    run.trains.push(state.id);
    run.endedAt = state.endedAt;
    const got = reply as { ok: boolean; error?: string } | null;
    if (state.status === 'paused') {
      run.status = 'paused';
      run.reason = state.reason;
      run.pauses.push({ at: state.endedAt ?? new Date().toISOString(), train: state.id, reason: state.reason, done: state.steps?.done ?? run.saved, saved: run.saved, lost: state.steps?.lost ?? 0 });
    } else if (state.status === 'done' && got?.ok === true && run.saved >= run.iters) {
      run.status = 'trained';
    } else {
      run.status = 'failed';
      run.reason = got?.ok === false ? `the trainer answered: ${got.error ?? 'an error'}` : state.reason ?? `the trainer stopped at step ${run.saved} of ${run.iters} without finishing`;
    }
    writeRun(run);
    return answer(run.status, run.reason, run, state);
  } finally {
    training = false;
  }
}

// ---------------------------------------------------------------- the base model download (Decision 6)

/**
 * The hosts the download's proxy allows, and no others, each exact. With the xet transfer off the Hub
 * still serves a xet-stored file by redirecting to its own bridge, `cas-bridge.xethub.hf.co`.
 */
export const HF_HOSTS: readonly string[] = ['huggingface.co', 'cdn-lfs.huggingface.co', 'cdn-lfs-us-1.huggingface.co', 'cas-bridge.xethub.hf.co', 'us.aws.cdn.hf.co', 'eu.aws.cdn.hf.co', 'cdn-lfs-eu-1.huggingface.co'];
const HF_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

type EgressStarter = (runId: string, log: (line: RunLogLine) => void) => Promise<Egress>;
let egressStarter: EgressStarter = (runId, log) => startEgress(runId, log);

/** Installs the download's proxy for tests (a fake), or `null` for the real `startEgress`. */
export function setEgressStarter(fn: EgressStarter | null): void {
  egressStarter = fn ?? ((runId, log) => startEgress(runId, log));
}

export interface DownloadResult {
  status: 'ready' | 'failed';
  reason: string | null;
}

let download: { promise: Promise<DownloadResult>; kill: (() => void) | null } | null = null;

/** Stops a download in progress (the engine stopping); it resumes from its partial files at the next click. */
export function stopDownload(): void {
  download?.kill?.();
}

/**
 * Downloads the base model, on his click only (Decision 6): `school.py
 * download_base`, which runs `snapshot_download` into `loraBaseDir()`. It
 * runs under its own trainer profile whose one network exception is the
 * loopback port of a per-download egress proxy allowing only `HF_HOSTS`,
 * with `HTTPS_PROXY` pointing at it, `HF_HUB_DISABLE_XET=1`, an empty
 * `HF_TOKEN` (his login is never sent) and `HF_HUB_OFFLINE` unset. Sets
 * `baseModelReady` when the files are there. A second click while it runs
 * waits on the same download.
 */
export function downloadBase(): Promise<DownloadResult> {
  if (baseReady()) return Promise.resolve({ status: 'ready', reason: null });
  if (download) return download.promise;
  const entry: { promise: Promise<DownloadResult>; kill: (() => void) | null } = { promise: Promise.resolve({ status: 'failed', reason: null }), kill: null };
  entry.promise = runDownload((kill) => {
    entry.kill = kill;
  }).finally(() => {
    if (download === entry) download = null;
  });
  download = entry;
  return entry.promise;
}

async function runDownload(onKill: (kill: () => void) => void): Promise<DownloadResult> {
  const failed = (reason: string): DownloadResult => ({ status: 'failed', reason });
  const python = trainerPython();
  if (!python) return failed('The trainer is not set up on this Mac');
  const repo = getSettings().school.baseModel;
  if (!HF_REPO.test(repo) || repo.includes('..')) return failed(`not a model name: ${repo}`);
  const school = paths().school;
  const tmp = join(school, 'tmp');
  mkdirSync(tmp, { recursive: true });
  const runId = `download-base-${randomUUID().slice(0, 8)}`;
  let egress: Egress | null = null;
  try {
    // what the proxy refused is read back with refusedHosts for the reason below
    egress = await egressStarter(runId, () => {});
    egress.setStage('install', [...HF_HOSTS]);
    const argv = wrap([python, join(TRAINER_DIR, 'school.py')], 'trainer', { school, tmp, proxyPort: egress.port, name: 'trainer-download.sb' }, () => {});
    const env: Record<string, string> = { ...trainerEnv() };
    delete env.HF_HUB_OFFLINE;
    Object.assign(env, {
      HOME: tmp,
      TMPDIR: tmp,
      HF_HOME: join(school, 'lora', 'hf'),
      HF_HUB_DISABLE_XET: '1',
      HF_TOKEN: '',
      HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
      HTTPS_PROXY: `http://palimpsest:${egress.token}@127.0.0.1:${egress.port}`,
    });
    const child = getSpawner()(argv[0], argv.slice(1), {
      cwd: tmp,
      env,
      clearEnv: true,
      stdin: JSON.stringify({ id: 1, cmd: 'download_base', repo, dir: loraBaseDir() }) + '\n',
      killGraceMs: GATE.killGraceMs,
    });
    onKill(() => child.kill('SIGTERM'));
    let reply: { ok: boolean; error?: string } | null = null;
    for await (const line of child.lines) {
      if (line.stream !== 'stdout' || !line.line.startsWith('{')) continue;
      try {
        const d = JSON.parse(line.line) as Record<string, unknown>;
        if (d && typeof d.ok === 'boolean') reply = { ok: d.ok, error: typeof d.error === 'string' ? d.error : undefined };
      } catch {
        // not one of ours
      }
    }
    const done = await child.done;
    const got = reply as { ok: boolean; error?: string } | null;
    if (got?.ok === true && done.code === 0 && existsSync(join(loraBaseDir(), 'config.json'))) {
      patchSettings({ school: { ...getSettings().school, baseModelReady: true } });
      return { status: 'ready', reason: null };
    }
    const refused = refusedHosts(runId);
    const why = got?.ok === false ? (got.error ?? 'an error') : done.error ? `it could not start: ${done.error}` : done.signal ? `it was stopped by ${done.signal}` : `it exited ${done.code}`;
    return failed(`The base model did not download: ${why}${refused.length ? ` (the proxy refused ${refused.join(', ')})` : ''}`);
  } catch (err) {
    return failed(`The base model did not download: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    try {
      await egress?.close();
    } catch {
      // best effort
    }
    // its token and port are forgotten with it
    rmSync(join(paths().runs, runId), { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- graduation (ruling 25, Task 27)

/** The base genome's id in a sealed race: the base model alone (`mlx:base`). */
export const BASE_GENOME = 'base';
/** Instructions a graduate is given, and both sides of its sealed race: its training is in its adapter, so they are plain. */
export const GRADUATE_INSTRUCTIONS =
  'You work on his repositories. Read the task and the files it names, find the smallest change that does what it asks, make it, and run the checks before you answer. Say plainly what you changed and why.\n';
/** Sealed races of one LoRA that may stop before the tick holds it until he asks again. */
export const EVAL_RETRIES = 2;
/** How often a sealed race reads the stop file and the switch; the gate is read every `GATE.pollMs`. */
const EVAL_POLL_MS = 2_000;

/** One sealed race of an adapter against its base: what it raced, what it cost and what came of it. */
export interface LoraEvaluation {
  at: string;
  /** `passed`: the paired interval sits above zero; `failed`: it does not; `stopped`: the race did not finish. */
  status: 'passed' | 'failed' | 'stopped';
  reason: string | null;
  /** The train (kind `eval`) the race held. */
  train: string;
  /** Each arena raced: the sealed hash Beagle used, the arena's sealed uses after this one, and the tasks both sides finished (0 when the hash had changed). */
  arenas: Array<{ id: string; hash: string | null; uses: number; tasks: number }>;
  sealed: Interval | null;
  baseSealed: Interval | null;
  vsBase: { diff: number; lo: number; hi: number } | null;
  credits: number;
  /** The graduate it made, once `graduate()` made one. */
  graduate: string | null;
}

/** An adapter that cannot be scored now, and why; nothing was raced or spent. */
export class EvaluationRefused extends Error {
  override name = 'EvaluationRefused';
}

/** The arenas whose sealed splits stand in the school now, with their hashes: what a new LoRA's data is built without. */
function heldOutSplits(): Record<string, string> {
  const withSealed = new Set((openDb().prepare("SELECT DISTINCT arena FROM arena_tasks WHERE split = 'sealed'").all() as Array<{ arena: string }>).map((r) => r.arena));
  const out: Record<string, string> = {};
  for (const a of listArenas()) {
    if (a.sealedHash && withSealed.has(a.id) && (a.status === 'ready' || a.status === 'spent')) out[a.id] = a.sealedHash;
  }
  return out;
}

function putArena(info: ArenaInfo): void {
  openDb().prepare('INSERT OR REPLACE INTO arenas (id, repo, json) VALUES (?, ?, ?)').run(info.id, info.repo, JSON.stringify(info));
}

function runById(id: string): LoraRun | null {
  return loraRuns().find((r) => r.id === id) ?? null;
}

/** Puts `ev` on the LoRA's record, read afresh, replacing an evaluation of the same train. */
function keepEvaluation(id: string, ev: LoraEvaluation): void {
  const run = runById(id);
  if (!run) return;
  run.evaluations = [...(run.evaluations ?? []).filter((e) => e.train !== ev.train), ev];
  writeRun(run);
}

const iso = (ms: number) => new Date(ms).toISOString();
const two = (x: number) => x.toFixed(2);
const reasonOf = (s: AbortSignal): string => (s.reason instanceof Error ? s.reason.message : String(s.reason ?? 'stopped'));
const usesLine = (arenas: ArenaInfo[]) => arenas.map((a) => `${a.id}: ${a.sealedUses} of ${SEALED_USES} sealed uses`).join('; ');

/**
 * The arenas `run` may be scored on (ruling 25): those whose sealed split
 * its data was built without and that still hold that split unchanged
 * (`sealedHash` as recorded), ready or spent. Throws `EvaluationRefused`
 * when there are none, or when every one of them is spent.
 */
function scoringArenas(run: LoraRun): ArenaInfo[] {
  const held = run.sealedArenas ?? {};
  const eligible = Object.keys(held)
    .sort()
    .map((id) => arenaInfo(id))
    .filter((a): a is ArenaInfo => a !== null && (a.status === 'ready' || a.status === 'spent') && a.sealedHash !== null && a.sealedHash === held[a.id]);
  if (eligible.length === 0) throw new EvaluationRefused("No arena's sealed tasks were held out of its data and still stand unchanged, so there is nothing sealed to score it on");
  const usable = eligible.filter((a) => a.status !== 'spent' && a.sealedUses < SEALED_USES);
  if (usable.length === 0) {
    throw new EvaluationRefused(`sealed set spent: ${usesLine(eligible)}; no adapter is scored on a spent split until he rebuilds the arena`);
  }
  return usable;
}

/** Where the concurrency a sealed race set aside is kept until it is put back: `<school>/ctl/beagle-concurrency.json`. */
export function concurrencyMarker(): string {
  return join(paths().school, 'ctl', 'beagle-concurrency.json');
}

function putConcurrencyBack(b: BeagleApi, previous: string | null): void {
  if (previous !== null) b.store.open().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('concurrency', ?)").run(previous);
  else b.store.open().prepare("DELETE FROM settings WHERE key = 'concurrency'").run();
  rmSync(concurrencyMarker(), { force: true });
}

function markedConcurrency(): { previous: string | null } | null {
  try {
    const d = JSON.parse(readFileSync(concurrencyMarker(), 'utf8')) as { previous?: unknown };
    return { previous: typeof d.previous === 'string' ? d.previous : null };
  } catch {
    return null;
  }
}

/**
 * Sets Beagle's concurrency to one run at a time for a sealed race, so the
 * one server swaps between adapter and base per run, not per turn; returns
 * the restore. What it set aside is written under ctl first, so an engine
 * that stops mid-race has it put back at the next start
 * (`restoreBeagleConcurrency`).
 */
export function oneRunAtATime(b: BeagleApi): () => void {
  const row = b.store.open().prepare("SELECT value FROM settings WHERE key = 'concurrency'").get() as { value: string } | undefined;
  // a marker an earlier crash left holds the value from before that race: it stays the one to put back
  const previous = markedConcurrency()?.previous ?? row?.value ?? null;
  mkdirSync(join(concurrencyMarker(), '..'), { recursive: true });
  writeAtomic(concurrencyMarker(), JSON.stringify({ previous }) + '\n');
  b.store.open().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('concurrency', ?)").run(JSON.stringify(VOYAGE.concurrency));
  return () => {
    try {
      putConcurrencyBack(b, previous);
    } catch (err) {
      console.error("palimpsest: Beagle's concurrency could not be put back:", err);
    }
  };
}

/** At engine start: puts back the Beagle concurrency a sealed race set aside when the engine stopped mid-race. Answers whether there was one. */
export async function restoreBeagleConcurrency(): Promise<boolean> {
  const mark = markedConcurrency();
  if (!mark) {
    rmSync(concurrencyMarker(), { force: true });
    return false;
  }
  putConcurrencyBack(await loadBeagle(), mark.previous);
  return true;
}

function genomeOf(id: string, model: string, tools: string[]): BeagleGenome {
  return { id, name: id === BASE_GENOME ? 'The base model' : `Adapter ${id}`, model, instructions: GRADUATE_INSTRUCTIONS, tools: [...tools], workflow: { shape: 'single' }, memory: { examples: 0 } };
}

function trainCredits(loraId: string): number {
  return Math.round(creditEntries(loraId).filter((r) => r.kind === 'train').reduce((n, r) => n + r.credits, 0) * 1e6) / 1e6;
}

function putTrain(kind: 'train.started' | 'train.paused' | 'train.ended', t: TrainState, extra: object): void {
  openDb().prepare('INSERT OR REPLACE INTO trains (id, kind, status, json) VALUES (?, ?, ?, ?)').run(t.id, t.kind, t.status, JSON.stringify(t));
  const data = { train: structuredClone(t), ...extra };
  record(kind, data);
  emit(kind, structuredClone(data));
}

let evaluating = false;

/**
 * Scores a trained adapter against its base (ruling 25): one `sealedRace()`
 * per arena whose sealed split its data was built without (unchanged since,
 * and not spent), the adapter genome against the base genome with the same
 * single-shape instructions. Each race spends one sealed use of its arena,
 * as its first model call is made (the row and its ledger entry in one
 * write); a race stopped before that spends nothing. The tenth use spends
 * the split, and an arena with none left refuses with "sealed set spent".
 *
 * It holds the graduates' server, not the machine: the adapter and the base
 * alone (`mlx:base`, ruling 26's fence) are served in turn behind the heavy
 * gate, as a train of kind `eval` that every other train waits for. It is
 * refused while a heavy train holds the machine, and a heavy train that
 * takes it during the race stops it: a call the machine refused is never
 * scored. The stop file, the switch, a gate loss or a failed call stop it
 * the same way. Every call is charged `train` to the city under the LoRA.
 *
 * Throws `EvaluationRefused` (nothing raced, nothing spent) when it cannot
 * start; otherwise resolves with the evaluation, also kept on the LoRA's
 * record. It graduates nothing: `graduate()` does.
 */
export async function evaluateAdapter(loraId: string, now: number = Date.now()): Promise<LoraEvaluation> {
  if (evaluating) throw new EvaluationRefused('An adapter is already being scored');
  evaluating = true;
  try {
    return await evaluate(loraId, now);
  } finally {
    evaluating = false;
  }
}

async function evaluate(loraId: string, now: number): Promise<LoraEvaluation> {
  const mlx = await import('../market/mlx.js');
  const canStart = (): void => {
    if (!getSettings().school.enabled) throw new EvaluationRefused('The school is off');
    const down = mlx.heavyRunning();
    if (down) throw new EvaluationRefused(`The adapter is not scored while ${down} runs: the graduates' server stays down until it ends`);
    if (liveTrains().length > 0) throw new EvaluationRefused('A train is already running');
  };
  canStart();
  const run = runById(loraId);
  if (!run || !trainedAdapter(loraId)) throw new EvaluationRefused(`${loraId} is not a trained adapter, so it is not scored`);
  if (!baseReady()) throw new EvaluationRefused('The base model is not downloaded');
  scoringArenas(run);
  const g = await readGate('heavy', now);
  if (!g.ok) throw new EvaluationRefused(g.reason ?? 'the gate closed');
  canStart();

  const b = await loadBeagle();
  const usable = scoringArenas(run);
  if (usable.some((a) => !b.arenas.arenaIds().includes(a.id))) await registerArenas();
  const held = run.sealedArenas ?? {};
  const raced = usable.filter((a) => b.arenas.arenaIds().includes(a.id) && b.race.sealedHash(a.id) === held[a.id]);
  if (raced.length === 0) throw new EvaluationRefused("No arena it may be scored on holds the same sealed split in Beagle's store");
  canStart();

  const t0 = Date.now();
  const clock = () => now + (Date.now() - t0);
  const ctl = new AbortController();
  const train: TrainState = { id: `train-eval-${randomUUID().slice(0, 8)}`, kind: 'eval', status: 'running', reason: null, startedAt: iso(now), endedAt: null, seconds: 0, steps: null, credits: 0 };
  const lora = { id: loraId };
  /** The arenas whose use this evaluation spent, as the table holds them after it. */
  const spent: ArenaInfo[] = [];
  /** The arena whose race is under way and has not yet spent its use: its first model call spends it. */
  let unspent: ArenaInfo | null = null;
  /**
   * Spends one sealed use of `a` (ruling 25), the row and its ledger entry in
   * one write, so the table and the replay always agree. Called as the race's
   * first model call is made: from then on the sealed tasks may have been shown.
   */
  const spendUse = (a: ArenaInfo): void => {
    const db = openDb();
    db.exec('SAVEPOINT sealed_use');
    try {
      const fresh = arenaInfo(a.id) ?? a;
      const uses = fresh.sealedUses + 1;
      const next: ArenaInfo = { ...fresh, sealedUses: uses, status: uses >= SEALED_USES ? 'spent' : fresh.status };
      putArena(next);
      // the train as it runs, carrying the arena whole: replay folds it as it folds every school entry's arenas
      record('train.started', { train: structuredClone(train), lora, arenas: [structuredClone(next)], sealedUse: next.id });
      db.exec('RELEASE sealed_use');
      spent.push(next);
    } catch (err) {
      db.exec('ROLLBACK TO sealed_use');
      db.exec('RELEASE sealed_use');
      throw err;
    }
  };
  const unhold = holdTrain(train, (reason) => ctl.abort(reason));
  const unregister = registerAbort(() => ctl.abort(TURNED_OFF_REASON));
  const releaseBase = mlx.serveBase();
  const restore = oneRunAtATime(b);
  const creditsBefore = trainCredits(loraId);
  const inner = schoolDriver({ voyageId: loraId, designer: getSettings().school.designer, signal: ctl.signal, now: clock, kind: 'train' });
  const driver: BeagleDriver = async (provider, name, turns, call) => {
    // a race stopped before its first call spends nothing
    if (ctl.signal.aborted) throw new Error(reasonOf(ctl.signal));
    if (unspent) {
      const a = unspent;
      unspent = null;
      spendUse(a);
    }
    try {
      return await inner(provider, name, turns, call);
    } catch (err) {
      // a call the machine could not answer (a heavy train took it, the server failed) is never scored as the model's miss
      if (!(err instanceof b.models.LimitError) && !ctl.signal.aborted) ctl.abort(err instanceof Error ? err.message : String(err));
      throw err;
    }
  };
  useDriver(driver);
  /** The stop file, the switch and a heavy train, read without waiting: any of them stops the evaluation. */
  const checkNow = (): boolean => {
    if (ctl.signal.aborted) return true;
    if (existsSync(paths().stop)) ctl.abort('The stop file is set.');
    else if (!getSettings().school.enabled) ctl.abort(TURNED_OFF_REASON);
    else if (mlx.heavyRunning()) ctl.abort(`${mlx.heavyRunning()} took the machine`);
    return ctl.signal.aborted;
  };
  let lastGate = Date.now();
  const timer = setInterval(() => {
    if (checkNow()) return;
    if (Date.now() - lastGate >= GATE.pollMs) {
      lastGate = Date.now();
      void readGate('heavy', clock()).then(
        (gs) => {
          if (!gs.ok && !ctl.signal.aborted) ctl.abort(gs.reason ?? 'the gate closed');
        },
        (err: unknown) => {
          if (!ctl.signal.aborted) ctl.abort(`the gate could not be read: ${err instanceof Error ? err.message : String(err)}`);
        },
      );
    }
  }, EVAL_POLL_MS);
  timer.unref?.();

  const arenas: LoraEvaluation['arenas'] = [];
  const mine: number[] = [];
  const theirs: number[] = [];
  const changed: string[] = [];
  let stop: string | null = null;
  const usesOf = (id: string) => spent.find((x) => x.id === id)?.sealedUses ?? arenaInfo(id)?.sealedUses ?? 0;
  try {
    putTrain('train.started', train, { lora, arenas: [] });
    for (const a of raced) {
      // read between races too: a stop that comes before an arena's race leaves its uses untouched
      if (checkNow()) {
        stop = reasonOf(ctl.signal);
        break;
      }
      const fresh = arenaInfo(a.id) ?? a;
      if (fresh.status === 'spent' || fresh.sealedUses >= SEALED_USES) continue;
      const tools = b.arenas.getArena(a.id).tools.map((t) => t.name);
      unspent = fresh;
      let r: Awaited<ReturnType<typeof b.race.sealedRace>>;
      try {
        r = await b.race.sealedRace(a.id, [genomeOf(loraId, `mlx:${loraId}`, tools), genomeOf(BASE_GENOME, mlx.MLX_BASE, tools)], { signal: ctl.signal, seed: 1 });
      } finally {
        unspent = null;
      }
      const ours = r.perTask[loraId] ?? {};
      const base = r.perTask[BASE_GENOME] ?? {};
      const tasks = Object.keys(ours).filter((t) => t in base).sort();
      if (!r.complete) {
        arenas.push({ id: a.id, hash: r.hash, uses: usesOf(a.id), tasks: 0 });
        stop = ctl.signal.aborted ? reasonOf(ctl.signal) : (r.reason ?? 'the sealed race stopped');
        break;
      }
      // a split that changed since the data was built without it is not the one held out: it scores nothing
      if (r.hash !== held[a.id] || r.hash !== a.sealedHash) {
        changed.push(a.id);
        arenas.push({ id: a.id, hash: r.hash, uses: usesOf(a.id), tasks: 0 });
        continue;
      }
      arenas.push({ id: a.id, hash: r.hash, uses: usesOf(a.id), tasks: tasks.length });
      for (const t of tasks) {
        mine.push(ours[t]);
        theirs.push(base[t]);
      }
    }
  } catch (err) {
    stop = ctl.signal.aborted ? reasonOf(ctl.signal) : err instanceof Error ? err.message : String(err);
  } finally {
    clearInterval(timer);
    unregister();
    useDriver(null);
    releaseBase();
    restore();
  }
  const extra = { lora, arenas: spent.map((a) => structuredClone(arenaInfo(a.id) ?? a)) };

  const end = clock();
  const ev: LoraEvaluation = { at: iso(now), status: 'stopped', reason: null, train: train.id, arenas, sealed: null, baseSealed: null, vsBase: null, credits: 0, graduate: null };
  if (stop !== null) {
    ev.reason = spent.length
      ? `${stop}. The sealed race stopped before it finished, and the uses its races began are spent (${usesLine(spent)}); it is not scored`
      : `${stop}. The sealed race stopped before its first call, so no sealed use was spent; it is not scored`;
  } else if (mine.length === 0) {
    ev.status = 'failed';
    ev.reason = changed.length ? `The sealed tasks of ${changed.join(', ')} changed since its data was built, so nothing was scored` : 'No sealed task was finished by both the adapter and its base';
  } else {
    ev.sealed = ci(mine, 1);
    ev.baseSealed = ci(theirs, 1);
    ev.vsBase = pairedCi(mine, theirs, 1);
    const won = ev.vsBase.lo > 0;
    ev.status = won ? 'passed' : 'failed';
    ev.reason = won
      ? null
      : `The adapter did not beat its base on the sealed tasks: the paired difference was ${two(ev.vsBase.diff)} [${two(ev.vsBase.lo)}, ${two(ev.vsBase.hi)}] over ${mine.length} sealed tasks (adapter ${two(ev.sealed.value)} against base ${two(ev.baseSealed.value)}), and it graduates only when the whole interval is above zero`;
  }
  ev.credits = Math.round((trainCredits(loraId) - creditsBefore) * 1e6) / 1e6;

  train.status = ev.status === 'stopped' ? 'paused' : 'done';
  train.reason = ev.status === 'stopped' ? stop : null;
  train.endedAt = iso(end);
  train.seconds = Math.max(0, Math.round((Date.now() - t0) / 1000));
  train.credits = ev.credits;
  if (train.status === 'paused') putTrain('train.paused', train, { ...extra, reason: train.reason, lost: 0 });
  else putTrain('train.ended', train, extra);
  unhold();
  keepEvaluation(loraId, ev);
  return structuredClone(ev);
}

/**
 * The short name of a base model for its graduates' names: the model's own
 * name, its version's dots dropped, each later word's first letter and its
 * size in billions, without the instruct, chat and quantization words.
 * `mlx-community/Qwen2.5-Coder-7B-Instruct-4bit` is `qwen25c7`.
 */
export function baseShort(repo: string): string {
  const name = (repo.split('/').pop() ?? repo).toLowerCase();
  const [first, ...rest] = name.split(/[-_]+/).filter(Boolean);
  let out = (first ?? '').replace(/[^a-z0-9]/g, '');
  for (const t of rest) {
    if (/^(instruct|chat|it|base|hf|mlx|gguf)$/.test(t) || /^\d+bits?$/.test(t) || /^q\d/.test(t) || /^(fp|bf)\d+$/.test(t)) continue;
    const size = /^(\d+(?:\.\d+)?)b$/.exec(t);
    out += size ? size[1].replace('.', '') : (t.replace(/[^a-z0-9]/g, '')[0] ?? '');
  }
  return out.slice(0, 24) || 'base';
}

/** Every graduate, oldest first; `agentId` is the agent it was hired as, once a firm has hired it. */
export function graduates(): Graduate[] {
  const rows = openDb().prepare('SELECT json FROM graduates').all() as Array<{ json: string }>;
  const out: Graduate[] = [];
  for (const r of rows) {
    try {
      out.push(JSON.parse(r.json) as Graduate);
    } catch {
      // a row that cannot be read is left out, never guessed at
    }
  }
  return out
    .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id))
    .map((g) => ({ ...g, agentId: storedAgent(g.id) ? g.id : (g.agentId ?? null) }));
}

/**
 * Graduates the LoRA `loraId` (ruling 25) when its sealed race against its
 * base (`evaluateAdapter`) puts the paired interval above zero: it becomes
 * `mlx:grad-<base short>-<n>`, a roster agent of origin `school` whose tower
 * is collegiate, stored and recorded as `graduate.made { graduate, arenas }`
 * and emitted as `graduate.made { graduate }` for the city. Null when it did
 * not beat its base (the evaluation on its record says why, with the
 * numbers) or the race stopped. A LoRA that already graduated answers its
 * graduate and is not raced again. Throws `EvaluationRefused` as
 * `evaluateAdapter` does.
 */
export async function graduate(loraId: string, now: number = Date.now()): Promise<Graduate | null> {
  const already = graduates().find((g) => g.loraId === loraId);
  if (already) return already;
  const ev = await evaluateAdapter(loraId, now);
  const run = runById(loraId);
  if (ev.status !== 'passed' || !ev.sealed || !ev.baseSealed || !ev.vsBase || !run) return null;
  const short = baseShort(run.base);
  const prefix = `grad-${short}-`;
  const n = 1 + graduates().reduce((m, g) => (g.id.startsWith(prefix) ? Math.max(m, Number(g.id.slice(prefix.length)) || 0) : m), 0);
  const id = `${prefix}${n}`;
  const used = ev.arenas.filter((a) => a.tasks > 0).map((a) => a.id);
  const g: Graduate = {
    id,
    model: `mlx:${id}`,
    base: run.base,
    loraId,
    sealed: ev.sealed,
    baseSealed: ev.baseSealed,
    vsBase: ev.vsBase,
    examples: run.examples,
    arenas: used,
    at: iso(now),
    agentId: null,
  };
  openDb().prepare('INSERT OR REPLACE INTO graduates (id, json) VALUES (?, ?)').run(g.id, JSON.stringify(g));
  keepEvaluation(loraId, { ...ev, graduate: g.id });
  const arenas = used.map((a) => arenaInfo(a)).filter((a): a is ArenaInfo => a !== null);
  record('graduate.made', { graduate: structuredClone(g), arenas });
  emit('graduate.made', { graduate: structuredClone(g) });
  return structuredClone(g);
}

/**
 * The tick's graduation: the newest trained adapter that has not graduated
 * and has not been scored to the end yet is raced once against its base
 * (`graduate`). A race that stopped may be run again on a later night; a
 * scored one never is. Null when nothing graduated; a refusal is logged.
 */
export async function graduateDue(now: number = Date.now()): Promise<Graduate | null> {
  const t = trainedAdapter();
  if (!t || graduates().some((g) => g.loraId === t.id)) return null;
  const run = runById(t.id);
  if (!run || (run.evaluations ?? []).some((e) => e.status !== 'stopped')) return null;
  if (run.evaluationHeld) return null;
  const asked = run.evaluationAskedAt ?? '';
  const stops = (run.evaluations ?? []).filter((e) => e.status === 'stopped' && e.at > asked).length;
  if (stops >= EVAL_RETRIES) {
    run.evaluationHeld = `Its sealed race stopped ${stops} times before it finished, so the school does not race it again on its own until he asks`;
    writeRun(run);
    return null;
  }
  try {
    return await graduate(t.id, now);
  } catch (err) {
    if (!(err instanceof EvaluationRefused)) throw err;
    console.error(`palimpsest: ${t.id} was not scored: ${err.message}`);
    return null;
  }
}

/** He asks for a held LoRA to be raced again (the school screen's route): the hold is lifted and the stops so far no longer count. */
export function askEvaluation(loraId: string, now: number = Date.now()): LoraRun | null {
  const run = runById(loraId);
  if (!run) return null;
  run.evaluationHeld = null;
  run.evaluationAskedAt = iso(now);
  writeRun(run);
  return run;
}
