import type { Repo } from '../shared/types.js';
import { getRunner } from './exec.js';

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
  const result = await runGh(['issue', 'view', String(number), '-R', fullName, '--json', 'state']);
  const { state } = JSON.parse(result.stdout) as { state: string };
  return state === 'CLOSED' ? 'CLOSED' : 'OPEN';
}

/** Adds a label to an issue. */
export async function addLabel(fullName: string, number: number, label: string): Promise<void> {
  await runGh(['issue', 'edit', String(number), '-R', fullName, '--add-label', label]);
}

/** Removes a label from an issue. */
export async function removeLabel(fullName: string, number: number, label: string): Promise<void> {
  await runGh(['issue', 'edit', String(number), '-R', fullName, '--remove-label', label]);
}

/** Posts a comment on an issue. */
export async function commentIssue(fullName: string, number: number, body: string): Promise<void> {
  await runGh(['issue', 'comment', String(number), '-R', fullName, '--body', body]);
}
