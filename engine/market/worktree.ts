/**
 * Per-run worktrees (ruling 8). Each run gets its own clone of the repo's
 * bare mirror, made without hardlinks, on its own branch, whose push URL is
 * invalid on purpose. The engine's own git commands in a run dir run with
 * hooks and fsmonitor off, no system config and an empty global config, and
 * refuse once `.git/config` no longer matches the hash recorded at creation.
 */
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import type { Repo } from '../../shared/types.js';
import { paths } from '../home.js';
import { mirrorDir } from '../mirror.js';
import { SYSTEM_PATH } from './sandbox.js';

export const PUSH_URL = 'no-push://palimpsest';
export const AUTHOR = { name: 'Palimpsest', email: 'palimpsest@local' } as const;
const GIT_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 64 * 1024 * 1024;

/** The flags every engine git command in a run dir or ship clone carries (ruling 20). */
export const ENGINE_GIT_FLAGS = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'] as const;

/** Every control file of a run, in `<runRoot>/ctl` (outside the repo, read-only to both profiles). */
export function controlFiles(runId: string) {
  const dir = join(paths().runs, runId, 'ctl');
  return {
    dir,
    gitconfig: join(dir, 'gitconfig'),
    npmrc: join(dir, 'npmrc'),
    gitConfigSha: join(dir, 'git-config.sha'),
    egressToken: join(dir, 'egress.token'),
    egressJson: join(dir, 'egress.json'),
    toolProfile: join(dir, 'tool.sb'),
    cliProfile: join(dir, 'cli.sb'),
    settings: join(dir, 'settings.json'),
    persona: join(dir, 'persona.md'),
    mcp: join(dir, 'mcp.json'),
    brokerJson: join(dir, 'broker.json'),
    brokerToken: join(dir, 'broker.token'),
  };
}

/**
 * The environment of the engine's own git in a run root: nothing from the
 * engine, an empty global config, no system config. HOME is not the agent's
 * fake home, so the reaper's environment marker never names engine git.
 */
export function engineGitEnvFor(runRoot: string): Record<string, string> {
  return {
    PATH: SYSTEM_PATH.join(':'),
    HOME: join(runRoot, 'ctl', 'git-home'),
    LANG: 'en_US.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(runRoot, 'ctl', 'gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    GIT_PAGER: 'cat',
  };
}

type GitResult = { stdout: string; stderr: string; code: number };

function git(args: string[], cwd: string, runRoot: string, extraEnv: Record<string, string> = {}): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...ENGINE_GIT_FLAGS, ...args],
      { cwd, env: { ...engineGitEnvFor(runRoot), ...extraEnv }, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && typeof (err as NodeJS.ErrnoException).code === 'string') {
          reject(err);
          return;
        }
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });
}

async function gitOk(args: string[], cwd: string, runRoot: string, extraEnv?: Record<string, string>): Promise<string> {
  const r = await git(args, cwd, runRoot, extraEnv);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

/** The hash file that records a clone's `.git/config` (`git-config.sha` for the run's repo). */
function shaFile(dir: string): string {
  const name = basename(dir);
  return join(dirname(dir), 'ctl', name === 'repo' ? 'git-config.sha' : `git-config.${name}.sha`);
}

/** sha256 of `<dir>/.git/config`, read without following a symlink. */
function configHash(dir: string): string {
  const fd = openSync(join(dir, '.git', 'config'), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return createHash('sha256').update(readFileSync(fd)).digest('hex');
  } finally {
    closeSync(fd);
  }
}

/** Records the current `.git/config` hash of a clone under its run root. */
export function recordGitConfig(dir: string): void {
  const file = shaFile(dir);
  mkdirSync(dirname(file), { recursive: true });
  rmSync(file, { force: true });
  writeFileSync(file, configHash(dir) + '\n', { mode: 0o444 });
}

/**
 * Runs git as the engine in a run dir (or a ship clone) with hooks and
 * fsmonitor off and no system or global config, after checking that the
 * clone's `.git/config` still matches the recorded hash.
 */
export async function engineGit(dir: string, args: string[]): Promise<GitResult> {
  return checkedGit(dir, args);
}

/** Files that point git at another directory or add per-worktree config: none may exist in a run clone's .git. */
export const REDIRECT_FILES = ['commondir', 'gitdir', 'config.worktree'] as const;

const LAYOUT = 'run dir git layout changed';

function lstatOrNull(p: string) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}

/**
 * The clone's layout as the engine left it: the dir and its .git are real
 * directories (no symlink), the dir resolves where it sits, and nothing in
 * .git redirects git elsewhere. Returns the resolved dir and git dir.
 */
function checkLayout(dir: string): { work: string; gitDir: string } {
  const d = lstatOrNull(dir);
  if (!d || d.isSymbolicLink() || !d.isDirectory()) throw new Error(LAYOUT);
  const work = realpathSync.native(dir);
  if (work !== join(realpathSync.native(dirname(dir)), basename(dir))) throw new Error(LAYOUT);
  const gitDir = join(work, '.git');
  const g = lstatOrNull(gitDir);
  if (!g || g.isSymbolicLink() || !g.isDirectory()) throw new Error(LAYOUT);
  for (const f of REDIRECT_FILES) if (lstatOrNull(join(gitDir, f))) throw new Error(LAYOUT);
  return { work, gitDir };
}

/**
 * Every engine git call in a clone: checks the layout and the recorded
 * config hash, then runs git with an explicit --git-dir and --work-tree (so
 * no .git file, core.worktree or environment can redirect it) and confirms
 * the common dir is the clone's own .git.
 */
async function checkedGit(dir: string, args: string[], extraEnv?: Record<string, string>): Promise<GitResult> {
  const { work, gitDir } = checkLayout(dir);
  let recorded: string;
  let now: string;
  try {
    recorded = readFileSync(shaFile(dir), 'utf8').trim();
    now = configHash(work);
  } catch {
    throw new Error('run dir git config changed');
  }
  if (now !== recorded) throw new Error('run dir git config changed');
  const explicit = [`--git-dir=${gitDir}`, `--work-tree=${work}`];
  const common = await git([...explicit, 'rev-parse', '--git-common-dir'], work, dirname(dir));
  if (common.code !== 0) throw new Error(LAYOUT);
  const c = common.stdout.trim();
  let commonReal: string;
  try {
    commonReal = realpathSync.native(resolve(work, c));
  } catch {
    throw new Error(LAYOUT);
  }
  if (commonReal !== gitDir) throw new Error(LAYOUT);
  return git([...explicit, ...args], work, dirname(dir), extraEnv);
}

async function engineGitOk(dir: string, args: string[], extraEnv?: Record<string, string>): Promise<string> {
  const r = await checkedGit(dir, args, extraEnv);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

/**
 * Creates `<home>/runs/<runId>/{repo,tmp,home,cache,ctl}`, clones the
 * repo's mirror into `repo` on the default branch without hardlinks,
 * branches, points the fetch URL at GitHub and the push URL nowhere, and
 * records the clone's `.git/config` hash.
 */
export async function createRunDir(repo: Repo, runId: string, branch: string): Promise<{ runRoot: string; dir: string; baseSha: string }> {
  const runRoot = join(paths().runs, runId);
  const dir = join(runRoot, 'repo');
  if (existsSync(dir)) throw new Error(`run dir already exists: ${dir}`);
  for (const d of ['tmp', 'ctmp', 'home', 'cache', 'ctl']) mkdirSync(join(runRoot, d), { recursive: true });
  const ctl = controlFiles(runId);
  for (const f of [ctl.gitconfig, ctl.npmrc]) {
    rmSync(f, { force: true });
    writeFileSync(f, '', { mode: 0o444 });
    chmodSync(f, 0o444);
  }

  await gitOk(['clone', '--quiet', '--local', '--no-hardlinks', '--branch', repo.defaultBranch, mirrorDir(repo.fullName), dir], runRoot, runRoot);
  await gitOk(['checkout', '--quiet', '-b', branch], dir, runRoot);
  await gitOk(['remote', 'set-url', 'origin', `https://github.com/${repo.fullName}.git`], dir, runRoot);
  await gitOk(['remote', 'set-url', '--push', 'origin', PUSH_URL], dir, runRoot);
  recordGitConfig(dir);
  const baseSha = (await engineGit(dir, ['rev-parse', 'HEAD'])).stdout.trim();
  return { runRoot, dir, baseSha };
}

/**
 * Makes `<runRoot>/base`, a checkout of `sha` cloned from the repo's mirror
 * without hardlinks (the design check builds and shoots the base side
 * there, Task 15). Its push URL is invalid like the run's, and its
 * `.git/config` hash is recorded so later engine git calls check it.
 */
export async function createBaseDir(repo: Repo, runId: string, sha: string): Promise<string> {
  const runRoot = join(paths().runs, runId);
  const dir = join(runRoot, 'base');
  if (existsSync(dir)) throw new Error(`base dir already exists: ${dir}`);
  mkdirSync(join(runRoot, 'ctl'), { recursive: true });
  const ctl = controlFiles(runId);
  if (!existsSync(ctl.gitconfig)) writeFileSync(ctl.gitconfig, '', { mode: 0o444 });
  await gitOk(['clone', '--quiet', '--local', '--no-hardlinks', '--no-checkout', mirrorDir(repo.fullName), dir], runRoot, runRoot);
  await gitOk(['remote', 'set-url', '--push', 'origin', PUSH_URL], dir, runRoot);
  recordGitConfig(dir);
  const co = await engineGit(dir, ['checkout', '--quiet', '--detach', sha]);
  if (co.code !== 0) throw new Error(`The base could not check out ${sha.slice(0, 7)}: ${co.stderr.trim()}`);
  return dir;
}

/**
 * Removes a directory the engine made in a run root (a clone or scratch dir
 * an earlier inspection left), never following a symlink: a symlink at the
 * path is unlinked, not its target. A tree its code made unwritable is made
 * writable first.
 */
export function removeOwned(path: string): void {
  const st = lstatOrNull(path);
  if (!st) return;
  if (st.isSymbolicLink() || !st.isDirectory()) {
    rmSync(path, { force: true });
    return;
  }
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    spawnSync('/bin/chmod', ['-R', 'u+rwx', path]);
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Makes `<runRoot>/ship` (ruling 20): a fresh clone of the repo's mirror,
 * without hardlinks, into which the engine fetches the run branch from the
 * run dir as data, checks that its tip is `headSha` (the engine's own
 * commit), and checks out exactly that sha. The inspection runs its checks
 * and the head preview here, so nothing the agent left in its run dir
 * (ignored files, build output, installed tools) is ever run or served,
 * and Task 16 ships from the same clone.
 */
export async function createShipDir(repo: Repo, runId: string, runDir: string, branch: string, headSha: string): Promise<string> {
  const runRoot = join(paths().runs, runId);
  const dir = join(runRoot, 'ship');
  // A ship clone left by an earlier inspection of this run is replaced, never reused.
  removeOwned(dir);
  rmSync(join(runRoot, 'ctl', 'git-config.ship.sha'), { force: true });
  mkdirSync(join(runRoot, 'ctl'), { recursive: true });
  const ctl = controlFiles(runId);
  if (!existsSync(ctl.gitconfig)) writeFileSync(ctl.gitconfig, '', { mode: 0o444 });
  // The run dir's layout and config are checked before it is read from at all.
  const tip = (await engineGitOk(runDir, ['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])).trim();
  if (tip !== headSha) throw new Error(`The run branch is at ${tip.slice(0, 7)}, not the engine's commit ${headSha.slice(0, 7)}.`);
  await gitOk(['clone', '--quiet', '--local', '--no-hardlinks', '--no-checkout', mirrorDir(repo.fullName), dir], runRoot, runRoot);
  await gitOk(['remote', 'set-url', '--push', 'origin', PUSH_URL], dir, runRoot);
  recordGitConfig(dir);
  await engineGitOk(dir, ['-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', runDir, `+refs/heads/${branch}:refs/palimpsest/head`]);
  const fetched = (await engineGitOk(dir, ['rev-parse', '--verify', 'refs/palimpsest/head^{commit}'])).trim();
  if (fetched !== headSha) throw new Error(`The fetched run branch is at ${fetched.slice(0, 7)}, not ${headSha.slice(0, 7)}.`);
  await engineGitOk(dir, ['checkout', '--quiet', '--detach', headSha]);
  return dir;
}

/** The run's change against its base: the patch (untracked files included), the files, the changed line count and the patch hash. */
export async function diffOf(dir: string, baseSha: string): Promise<{ patch: string; files: string[]; lines: number; sha256: string }> {
  await engineGitOk(dir, ['add', '--all']);
  const common = ['--no-color', '--no-ext-diff', '--no-textconv', '--cached', baseSha, '--'];
  const patch = await engineGitOk(dir, ['diff', '--binary', ...common]);
  const names = await engineGitOk(dir, ['diff', '--name-only', '-z', ...common]);
  const numstat = await engineGitOk(dir, ['diff', '--numstat', ...common]);
  const files = names.split('\0').filter(Boolean);
  let lines = 0;
  for (const row of numstat.split('\n')) {
    const [a, d] = row.split('\t');
    if (a && a !== '-') lines += Number(a);
    if (d && d !== '-') lines += Number(d);
  }
  return { patch, files, lines, sha256: createHash('sha256').update(patch).digest('hex') };
}

/**
 * Commits everything in the run dir as Palimpsest with a `Palimpsest-Job`
 * trailer. Returns the new head sha, or null when nothing changed.
 */
export async function commitAll(dir: string, message: string, jobId: string): Promise<string | null> {
  await engineGitOk(dir, ['add', '--all']);
  const quiet = await engineGit(dir, ['diff', '--cached', '--quiet']);
  if (quiet.code === 0) return null;
  const identity = {
    GIT_AUTHOR_NAME: AUTHOR.name,
    GIT_AUTHOR_EMAIL: AUTHOR.email,
    GIT_COMMITTER_NAME: AUTHOR.name,
    GIT_COMMITTER_EMAIL: AUTHOR.email,
  };
  const body = `${message.trim()}\n\nPalimpsest-Job: ${jobId}\n`;
  await engineGitOk(dir, ['commit', '--quiet', '--no-verify', '--no-gpg-sign', '-m', body], identity);
  return (await engineGitOk(dir, ['rev-parse', 'HEAD'])).trim();
}

/** What removeRunDir keeps in a run root. */
export const KEPT = ['log.jsonl', 'diff.patch', 'inspection'] as const;

/** Removes a run's clones, home, caches and control files, keeping its log, its patch and its inspection. */
export function removeRunDir(runId: string): void {
  const runRoot = join(paths().runs, runId);
  let entries: string[];
  try {
    entries = readdirSync(runRoot);
  } catch {
    return;
  }
  for (const e of entries) {
    if ((KEPT as readonly string[]).includes(e)) continue;
    rmSync(join(runRoot, e), { recursive: true, force: true });
  }
}
