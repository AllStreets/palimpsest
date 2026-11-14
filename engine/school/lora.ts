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
 * - `no-edit`: it changed no source file a racer may edit.
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
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LORA } from '../../shared/school-rules.js';
import type { Repo } from '../../shared/types.js';
import { getRunner } from '../exec.js';
import { paths } from '../home.js';
import { mirrorDir } from '../mirror.js';
import { ENGINE_GIT_FLAGS } from '../market/worktree.js';
import { listRepos } from '../repos.js';
import { protectedReason, sealedRefs, toBeagleArena, type ArenaEdit } from './arenas.js';
import { isSourceFile, verifiedChanges, type VerifiedChange } from './history.js';

export type LoraSkip = 'sealed' | 'too-large' | 'too-long' | 'not-unique' | 'no-edit';

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

  const raw = await rawDiff(repo, c.parent, c.sha);
  if (!raw) return { error: `the diff of ${c.ref} could not be read` };
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
  const skipped: Record<LoraSkip, number> = { sealed: 0, 'too-large': 0, 'too-long': 0, 'not-unique': 0, 'no-edit': 0 };
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
