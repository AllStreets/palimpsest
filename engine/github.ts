import type { Repo } from '../shared/types.js';
import { getRunner, realRunner } from './exec.js';
import { home, isRealDataHome } from './home.js';
import { mirrorDir, syncMirror, type Commit } from './mirror.js';

const TIMEOUT_MS = 120_000;

export type GhErrorKind = 'missing' | 'auth' | 'notfound' | 'other';

/** A gh CLI failure, classified so callers can show a readable, specific error. */
export class GhError extends Error {
  kind: GhErrorKind;

  constructor(kind: GhErrorKind, message: string) {
    super(message);
    this.name = 'GhError';
    this.kind = kind;
  }
}

export interface PR {
  number: number;
  title: string;
  mergedAt: string;
  mergeSha: string | null;
  url: string;
  /** The PR's head branch; the city's own PRs come from `palimpsest/<jobId>`. */
  headRefName: string;
}

interface RepoRow {
  nameWithOwner: string;
  isPrivate: boolean;
  description: string | null;
  primaryLanguage: { name: string } | null;
  defaultBranchRef: { name: string } | null;
}

interface PrListRow {
  number: number;
  title: string;
  mergedAt: string;
  mergeCommit: { oid: string } | null;
  url: string;
  headRefName: string;
}

/** Classifies a thrown spawn error (e.g. the runner rejecting because the binary itself is missing) into a GhError. */
export function classifySpawnError(err: unknown): GhError {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ENOENT') {
    return new GhError(
      'missing',
      'GitHub CLI (gh) is not installed. Install it from https://cli.github.com, then run `gh auth login`.',
    );
  }
  return new GhError('other', err instanceof Error ? err.message : String(err));
}

/**
 * Classifies a failed (non-zero exit) command result into a GhError: 'notfound'
 * when the repo doesn't resolve or isn't readable, 'auth' when `gh auth status`
 * also fails, 'other' otherwise. Shared by every gh call here and by mirror.ts's
 * git/gh calls, so a logged-out session or an unreadable private repo always
 * surfaces the same kind and a readable message, whichever command hit it.
 */
export async function classifyGhFailure(
  result: { stdout: string; stderr: string; code: number },
  commandLabel: string,
): Promise<GhError> {
  if (/Could not resolve to a Repository/.test(result.stderr) || /Repository not found/i.test(result.stderr)) {
    return new GhError('notfound', `Repository not found: ${result.stderr.trim()}`);
  }

  const runner = getRunner();
  const auth = await runner('gh', ['auth', 'status'], { timeoutMs: TIMEOUT_MS }).catch(
    () => ({ stdout: '', stderr: '', code: 1 }),
  );
  if (auth.code !== 0) {
    return new GhError('auth', 'Not logged in to the GitHub CLI. Run `gh auth login`, then try again.');
  }

  return new GhError('other', result.stderr.trim() || `${commandLabel} exited with code ${result.code}`);
}

/**
 * Runs a gh subcommand and returns its result, or throws a classified GhError
 * (see classifySpawnError / classifyGhFailure).
 */
async function runGh(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const runner = getRunner();
  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await runner('gh', args, { timeoutMs: TIMEOUT_MS });
  } catch (err) {
    throw classifySpawnError(err);
  }

  if (result.code === 0) {
    return result;
  }

  throw await classifyGhFailure(result, `gh ${args.join(' ')}`);
}

/** owner/name, each part letters, digits, `_`, `.` or `-` and not starting with `-` (so it can never read as a flag). */
const FULL_NAME = /^[\w.][\w.-]*\/[\w.][\w.-]*$/;

/** Throws before any gh call when a repo name could be anything but owner/name. */
function checkName(fullName: string): void {
  if (typeof fullName !== 'string' || !FULL_NAME.test(fullName)) {
    throw new GhError('other', `Bad repo name ${JSON.stringify(fullName)}: expected owner/name`);
  }
}

function checkIssue(number: number): void {
  if (!Number.isInteger(number) || number <= 0) throw new GhError('other', `Bad issue number ${number}`);
}

/** Repos the authenticated gh user can see, mapped to the subset of Repo fields gh gives us. */
export async function availableRepos(): Promise<
  Pick<Repo, 'fullName' | 'private' | 'description' | 'language' | 'defaultBranch'>[]
> {
  const result = await runGh([
    'repo',
    'list',
    '--limit',
    '500',
    '--json',
    'nameWithOwner,isPrivate,description,primaryLanguage,defaultBranchRef',
  ]);
  const rows = JSON.parse(result.stdout) as RepoRow[];
  return rows.map(mapRepoRow);
}

/** Maps a single gh repo row (from `repo list` or `repo view`) to our Repo subset. */
function mapRepoRow(row: RepoRow): Pick<Repo, 'fullName' | 'private' | 'description' | 'language' | 'defaultBranch'> {
  return {
    fullName: row.nameWithOwner,
    private: row.isPrivate,
    description: row.description ?? null,
    language: row.primaryLanguage?.name ?? null,
    defaultBranch: row.defaultBranchRef?.name ?? 'main',
  };
}

/** A single repo's current metadata, same mapping and error classification as availableRepos. */
export async function repoMeta(
  fullName: string,
): Promise<Pick<Repo, 'fullName' | 'private' | 'description' | 'language' | 'defaultBranch'>> {
  checkName(fullName);
  const result = await runGh([
    'repo',
    'view',
    fullName,
    '--json',
    'nameWithOwner,isPrivate,description,primaryLanguage,defaultBranchRef',
  ]);
  const row = JSON.parse(result.stdout) as RepoRow;
  return mapRepoRow(row);
}

/**
 * Merged PRs for a repo, in the order gh returns them (newest first).
 * additions/deletions are deliberately not requested: GitHub computes them
 * per PR, and with a few hundred merged PRs the GraphQL query fails every
 * time with a 502. A PR floor is sized from its merge commit's diff instead.
 */
export async function mergedPRs(fullName: string): Promise<PR[]> {
  checkName(fullName);
  const result = await runGh([
    'pr',
    'list',
    '-R',
    fullName,
    '--state',
    'merged',
    '--limit',
    '2000',
    '--json',
    'number,title,mergedAt,mergeCommit,url,headRefName',
  ]);
  const rows = JSON.parse(result.stdout) as PrListRow[];
  return rows.map((row) => ({
    number: row.number,
    title: row.title,
    mergedAt: row.mergedAt,
    mergeSha: row.mergeCommit?.oid ?? null,
    url: row.url,
    headRefName: row.headRefName ?? '',
  }));
}

/** An open issue as the market reads it: labels and author flattened to names. */
export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  url: string;
  author: string;
  updatedAt: string;
}

interface IssueRow {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }> | null;
  url: string;
  author: { login: string } | null;
  updatedAt: string;
}

/**
 * Open issues carrying one label. gh ANDs repeated `--label` flags, so the
 * market asks once per tier label and merges the lists itself (ruling 3).
 */
export async function openIssues(fullName: string, label: string): Promise<Issue[]> {
  checkName(fullName);
  const result = await runGh([
    'issue',
    'list',
    '-R',
    fullName,
    '--label',
    label,
    '--state',
    'open',
    '--limit',
    '200',
    '--json',
    'number,title,body,labels,url,author,updatedAt',
  ]);
  const rows = JSON.parse(result.stdout) as IssueRow[];
  return rows.map((row) => ({
    number: row.number,
    title: row.title,
    body: row.body ?? '',
    labels: (row.labels ?? []).map((l) => l.name),
    url: row.url,
    author: row.author?.login ?? '',
    updatedAt: row.updatedAt,
  }));
}

/** Whether one issue is open or closed. */
export async function issueState(fullName: string, number: number): Promise<'OPEN' | 'CLOSED'> {
  checkName(fullName);
  checkIssue(number);
  const result = await runGh(['issue', 'view', String(number), '-R', fullName, '--json', 'state']);
  const { state } = JSON.parse(result.stdout) as { state: string };
  return state === 'CLOSED' ? 'CLOSED' : 'OPEN';
}

/** Adds a label to an issue. */
export async function addLabel(fullName: string, number: number, label: string): Promise<void> {
  checkName(fullName);
  checkIssue(number);
  await runGh(['issue', 'edit', String(number), '-R', fullName, '--add-label', label]);
}

/** Removes a label from an issue. */
export async function removeLabel(fullName: string, number: number, label: string): Promise<void> {
  checkName(fullName);
  checkIssue(number);
  await runGh(['issue', 'edit', String(number), '-R', fullName, '--remove-label', label]);
}

/** Posts a comment on an issue. */
export async function commentIssue(fullName: string, number: number, body: string): Promise<void> {
  checkName(fullName);
  checkIssue(number);
  await runGh(['issue', 'comment', String(number), '-R', fullName, '--body', body]);
}

/** Colours and descriptions for the labels the city itself creates. */
const CITY_LABELS: Record<string, { color: string; description: string }> = {
  'palimpsest:done': { color: '2f6f4f', description: 'Palimpsest merged work for this issue' },
  'palimpsest:failed': { color: '8a3b2e', description: 'Palimpsest tried this issue and left it to you' },
};

/**
 * Creates a label on the repo only when it is missing, so `addLabel` cannot
 * fail on a repo that never had it. A create that loses a race to another
 * create ("already exists") counts as present.
 */
export async function ensureLabel(fullName: string, name: string): Promise<void> {
  checkName(fullName);
  const result = await runGh(['label', 'list', '-R', fullName, '--limit', '1000', '--json', 'name']);
  const names = (JSON.parse(result.stdout || '[]') as Array<{ name: string }>).map((l) => l.name.toLowerCase());
  if (names.includes(name.toLowerCase())) return;
  const meta = CITY_LABELS[name] ?? { color: 'cccccc', description: 'Palimpsest' };
  try {
    await runGh(['label', 'create', name, '-R', fullName, '--color', meta.color, '--description', meta.description]);
  } catch (err) {
    if (!/already exists/i.test(err instanceof Error ? err.message : String(err))) throw err;
  }
}

// ---------------------------------------------------------------- shipping (Task 16)

/** A branch the city pushes and opens PRs from: always `palimpsest/<jobId>`. */
const CITY_HEAD = /^palimpsest\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** A base branch name: never a flag, never `..`, never a refspec. */
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

function checkBranch(name: string, re: RegExp): void {
  if (typeof name !== 'string' || !re.test(name) || name.includes('..') || name.endsWith('/') || name.endsWith('.lock')) {
    throw new GhError('other', `Bad branch name ${JSON.stringify(name)}`);
  }
}

/** The title exactly as the city sends it to `gh pr create` (the revert watch matches against it). */
export function prTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, 240) || 'Palimpsest change';
}

/**
 * Real GitHub writes happen only from the real data home (the Task 5 guard):
 * with the real runner and a temp or sample home, a write is refused before
 * any gh call.
 */
export function githubWriteRefused(): string | null {
  if (getRunner() !== realRunner || isRealDataHome(home())) return null;
  return `GitHub writes are refused: ${home()} is not the real data home`;
}

/**
 * Opens a pull request from the city's branch `head` into `base` and
 * returns its number and URL. Title and body travel as `--flag=value`, so
 * no text can read as a flag.
 */
export async function createPR(
  fullName: string,
  pr: { head: string; base: string; title: string; body: string },
): Promise<{ number: number; url: string }> {
  checkName(fullName);
  checkBranch(pr.head, CITY_HEAD);
  checkBranch(pr.base, BRANCH);
  const refused = githubWriteRefused();
  if (refused) throw new GhError('other', refused);
  const title = prTitle(pr.title);
  const result = await runGh([
    'pr',
    'create',
    '-R',
    fullName,
    `--head=${pr.head}`,
    `--base=${pr.base}`,
    `--title=${title}`,
    `--body=${pr.body}`,
  ]);
  const url = result.stdout
    .split('\n')
    .map((l) => l.trim())
    .find((l) => /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+$/.test(l));
  if (!url) throw new GhError('other', `gh pr create printed no pull request URL: ${result.stdout.trim().slice(0, 200)}`);
  const [owner, name] = fullName.toLowerCase().split('/');
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)$/.exec(url)!;
  if (m[1].toLowerCase() !== owner || m[2].toLowerCase() !== name) throw new GhError('other', `gh pr create answered for another repo: ${url}`);
  return { number: Number(m[3]), url };
}

export interface PRState {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  mergedAt: string | null;
  mergeCommit: string | null;
  closedAt: string | null;
  /** The PR head's sha when it merged: the city pays only when it is the sha it pushed. */
  headRefOid: string | null;
  baseRefName: string | null;
}

/** A pull request's fate: open, merged (with its merge commit) or closed without a merge. */
export async function prState(fullName: string, number: number): Promise<PRState> {
  checkName(fullName);
  checkIssue(number);
  const result = await runGh(['pr', 'view', String(number), '-R', fullName, '--json', 'state,mergedAt,mergeCommit,closedAt,headRefOid,baseRefName']);
  const row = JSON.parse(result.stdout) as {
    state?: string;
    mergedAt?: string | null;
    mergeCommit?: { oid?: string } | null;
    closedAt?: string | null;
    headRefOid?: string | null;
    baseRefName?: string | null;
  };
  const state = row.state === 'MERGED' ? 'MERGED' : row.state === 'CLOSED' ? 'CLOSED' : 'OPEN';
  const oid = row.mergeCommit?.oid ?? null;
  return {
    state,
    mergedAt: row.mergedAt || null,
    mergeCommit: oid && /^[0-9a-f]{40}$/.test(oid) ? oid : null,
    closedAt: row.closedAt || null,
    headRefOid: typeof row.headRefOid === 'string' && /^[0-9a-f]{40}$/.test(row.headRefOid) ? row.headRefOid : null,
    baseRefName: typeof row.baseRefName === 'string' ? row.baseRefName : null,
  };
}

/** The numbers of open pull requests whose head is the city's branch `head`. */
export async function openPRsFrom(fullName: string, head: string): Promise<number[]> {
  checkName(fullName);
  checkBranch(head, CITY_HEAD);
  const result = await runGh(['pr', 'list', '-R', fullName, `--head=${head}`, '--state', 'open', '--json', 'number']);
  return (JSON.parse(result.stdout || '[]') as Array<{ number: number }>).map((p) => p.number);
}

/**
 * Commits on `branch` after `since`, newest first, every parent line, read
 * through the mirror (after `syncMirror` unless `sync` is false). `since` is
 * a commit sha (`<sha>..<branch>`, by ancestry: committer dates are never
 * trusted) or, failing that, an ISO time. Each commit's `parents` are given.
 */
export async function recentCommits(fullName: string, branch: string, since: string, o: { sync?: boolean; limit?: number } = {}): Promise<Array<Commit & { parents: string[] }>> {
  checkName(fullName);
  checkBranch(branch, BRANCH);
  const dir = o.sync === false ? mirrorDir(fullName) : await syncMirror(fullName);
  const RS = '\x1e';
  const US = '\x1f';
  const range: string[] = [];
  if (/^[0-9a-f]{40}$/.test(since)) range.push(`${since}..refs/heads/${branch}`);
  else {
    const at = Date.parse(since);
    if (Number.isFinite(at)) range.push(`--since=${new Date(at).toISOString()}`);
    range.push(`refs/heads/${branch}`);
  }
  const r = await getRunner()(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', dir, 'log', ...(o.limit ? [`-n${o.limit}`] : []), `--format=${RS}%H${US}%P${US}%aI${US}%an${US}%s${US}%b${US}`, ...range, '--'],
    { timeoutMs: TIMEOUT_MS },
  );
  if (r.code !== 0) throw new Error(`git log failed for ${branch} in ${dir}: ${r.stderr.trim()}`);
  return r.stdout
    .split(RS)
    .filter((c) => c.trim().length > 0)
    .map((chunk) => {
      const [sha, parents, at2, author, subject, body] = chunk.split(US);
      return { sha: (sha ?? '').trim(), parents: (parents ?? '').split(' ').filter(Boolean), at: at2 ?? '', author: author ?? '', subject: subject ?? '', body: (body ?? '').trim(), lines: 0 };
    });
}
