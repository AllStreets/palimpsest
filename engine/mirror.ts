import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getRunner } from './exec.js';
import { paths } from './home.js';

const TIMEOUT_MS = 120_000;

// Record separator / unit separator used to delimit fields in the git log
// format string below, chosen because they never occur in normal commit text.
const RS = '\x1e';
const US = '\x1f';

export interface Commit {
  sha: string;
  at: string;
  author: string;
  subject: string;
  body: string;
  lines: number;
}

function mirrorDir(fullName: string): string {
  const [owner, name] = fullName.split('/');
  return join(paths().mirrors, `${owner}__${name}.git`);
}

/**
 * Ensures a bare local mirror of `fullName` exists under paths().mirrors,
 * cloning it the first time and fetching (with prune) on every call after.
 * Returns the mirror's directory.
 */
export async function syncMirror(fullName: string): Promise<string> {
  const dir = mirrorDir(fullName);
  const runner = getRunner();

  if (existsSync(dir)) {
    const result = await runner('git', ['-C', dir, 'fetch', 'origin', '+refs/heads/*:refs/heads/*', '--prune'], {
      timeoutMs: TIMEOUT_MS,
    });
    if (result.code !== 0) {
      throw new Error(`git fetch failed for ${fullName}: ${result.stderr.trim()}`);
    }
    return dir;
  }

  const result = await runner('gh', ['repo', 'clone', fullName, dir, '--', '--bare'], { timeoutMs: TIMEOUT_MS });
  if (result.code !== 0) {
    throw new Error(`gh repo clone failed for ${fullName}: ${result.stderr.trim()}`);
  }
  return dir;
}

/**
 * Reads `branch`'s first-parent history from the mirror at `dir` as Commits.
 * An unborn/empty branch (no commits yet) returns [] rather than throwing.
 */
export async function readLog(dir: string, branch: string): Promise<Commit[]> {
  const runner = getRunner();
  const result = await runner(
    'git',
    [
      '-C',
      dir,
      'log',
      '--first-parent',
      '--reverse',
      `--format=${RS}%H${US}%aI${US}%an${US}%s${US}%b${US}`,
      '--numstat',
      branch,
    ],
    { timeoutMs: TIMEOUT_MS },
  );

  if (result.code !== 0) {
    // "does not have any commits [yet]" is git's message for HEAD on an
    // unborn branch: the repo truly has no commits, per global constraint #1
    // that must never surface as an error.
    if (/does not have any commits/.test(result.stderr)) {
      return [];
    }

    // "unknown revision" means the literal branch name doesn't resolve to a
    // ref. That's the same empty-repo case when the mirror has no refs at
    // all (a repo with zero commits can't have a branch ref either), but it
    // is a real error when the repo has commits under some other ref and
    // `branch` is simply wrong (e.g. a renamed default branch) — that must
    // not be swallowed as "empty". Disambiguate by checking whether any ref
    // exists at all.
    if (/unknown revision/.test(result.stderr)) {
      const refs = await runner('git', ['-C', dir, 'for-each-ref', '--count=1'], { timeoutMs: TIMEOUT_MS });
      if (refs.code === 0 && refs.stdout.trim() === '') {
        return [];
      }
      throw new Error(`branch '${branch}' not found in ${dir}: ${result.stderr.trim()}`);
    }

    throw new Error(`git log failed for ${branch} in ${dir}: ${result.stderr.trim()}`);
  }

  return parseLog(result.stdout);
}

/** Parses the raw --numstat log produced by readLog's format string into Commits. */
export function parseLog(raw: string): Commit[] {
  return raw
    .split(RS)
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const [sha, at, author, subject, body, tail] = chunk.split(US);
      const lines = (tail ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .reduce((sum, line) => {
          const [added, deleted] = line.split('\t');
          const a = added === '-' ? 0 : Number(added);
          const d = deleted === '-' ? 0 : Number(deleted);
          return sum + (Number.isFinite(a) ? a : 0) + (Number.isFinite(d) ? d : 0);
        }, 0);

      return {
        sha: sha ?? '',
        at: at ?? '',
        author: author ?? '',
        subject: subject ?? '',
        body: (body ?? '').trim(),
        lines,
      };
    });
}
