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
  lines: number;
  mergeSha: string | null;
  url: string;
}

interface RepoListRow {
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
  additions: number;
  deletions: number;
  mergeCommit: { oid: string } | null;
  url: string;
}

/**
 * Runs a gh subcommand and returns its result, or throws a classified GhError:
 * 'missing' when the gh binary itself is not installed (ENOENT), 'notfound'
 * when gh reports the repo doesn't resolve, 'auth' when `gh auth status`
 * also fails, 'other' otherwise.
 */
async function runGh(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const runner = getRunner();
  let result: { stdout: string; stderr: string; code: number };
  try {
    result = await runner('gh', args, { timeoutMs: TIMEOUT_MS });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ENOENT') {
      throw new GhError(
        'missing',
        'GitHub CLI (gh) is not installed. Install it from https://cli.github.com, then run `gh auth login`.',
      );
    }
    throw new GhError('other', err instanceof Error ? err.message : String(err));
  }

  if (result.code === 0) {
    return result;
  }

  if (result.stderr.includes('Could not resolve to a Repository')) {
    throw new GhError('notfound', `Repository not found: ${result.stderr.trim()}`);
  }

  const auth = await runner('gh', ['auth', 'status'], { timeoutMs: TIMEOUT_MS }).catch(
    () => ({ stdout: '', stderr: '', code: 1 }),
  );
  if (auth.code !== 0) {
    throw new GhError('auth', 'Not logged in to the GitHub CLI. Run `gh auth login`, then try again.');
  }

  throw new GhError('other', result.stderr.trim() || `gh ${args.join(' ')} exited with code ${result.code}`);
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
  const rows = JSON.parse(result.stdout) as RepoListRow[];
  return rows.map((row) => ({
    fullName: row.nameWithOwner,
    private: row.isPrivate,
    description: row.description ?? null,
    language: row.primaryLanguage?.name ?? null,
    defaultBranch: row.defaultBranchRef?.name ?? 'main',
  }));
}

/** Merged PRs for a repo, newest-list-order as gh returns them, with lines = additions + deletions. */
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
    'number,title,mergedAt,additions,deletions,mergeCommit,url',
  ]);
  const rows = JSON.parse(result.stdout) as PrListRow[];
  return rows.map((row) => ({
    number: row.number,
    title: row.title,
    mergedAt: row.mergedAt,
    lines: row.additions + row.deletions,
    mergeSha: row.mergeCommit?.oid ?? null,
    url: row.url,
  }));
}
