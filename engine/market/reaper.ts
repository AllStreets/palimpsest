/**
 * The reaper (Task 8 fix round): a command can fork, call setsid and leave
 * a daemon running inside the tool profile after its own process group is
 * gone. reapRun() finds every process of his user that belongs to a run and
 * kills it, TERM then KILL, signalling only pids that are verified to still
 * belong to the run at the moment of the signal.
 *
 * A process belongs to a run when:
 * - its environment carries the run's child markers (`HOME=<runRoot>/home`
 *   or `TMPDIR=<runRoot>/tmp/`, from childEnv), or
 * - its executable lives under the run root, or
 * - its working directory is under the run root and it has no controlling
 *   terminal (his own shell in a run dir has one, a tool child never does).
 *
 * - it runs under this run's own sandbox profile (sandbox-check.ts), which
 *   no process can drop: this catches a daemon that cleared its
 *   environment, left the run root and exec-ed a system binary.
 *
 * Never matched: the engine and its ancestors, the engine's descendants
 * that neither run under the run's sandbox nor carry its markers (its own
 * git, whose HOME is not the agent's), pids the run protects
 * (protectPids: the claude CLI, Task 9) and their descendants, and the
 * process groups of commands of the run that are still live.
 *
 * Open files other than the working directory and the executable are not
 * scanned: one `lsof` of every open file of his user takes seconds.
 */
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { join } from 'node:path';

import { mkdirSync } from 'node:fs';

import { sandboxMembers } from './sandbox-check.js';
import { realish } from './sandbox.js';

interface Proc {
  pid: number;
  ppid: number;
  pgid: number;
  tty: string;
  command: string;
}

const protectedPids = new Map<string, Set<number>>();
const liveGroups = new Map<string, Set<number>>();

function key(runRoot: string): string {
  return realish(runRoot);
}

/** Pids the reaper must leave alone for this run, with their descendants (the claude CLI and its MCP server and hook). Replaces the previous list. */
export function protectPids(runRoot: string, pids: number[]): void {
  if (pids.length) protectedPids.set(key(runRoot), new Set(pids));
  else protectedPids.delete(key(runRoot));
}

/** Marks a live command's process group, so a reap after another command of the same run leaves it running. */
export function noteLiveGroup(runRoot: string, pgid: number | null, live: boolean): void {
  if (pgid === null) return;
  const k = key(runRoot);
  const set = liveGroups.get(k) ?? new Set<number>();
  if (live) set.add(pgid);
  else set.delete(pgid);
  if (set.size) liveGroups.set(k, set);
  else liveGroups.delete(k);
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 30_000 }, (_err, stdout) => resolve(stdout ?? ''));
  });
}

/** Every process of his user, with its environment appended to the command (ps -E). */
async function processes(pids?: number[]): Promise<Proc[]> {
  const args = ['-wwE', '-o', 'pid=,ppid=,pgid=,tty=,command='];
  if (pids) args.push('-p', pids.join(','));
  else args.push('-U', String(userInfo().uid));
  const out = await run('/bin/ps', args);
  const procs: Proc[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), tty: m[4], command: m[5] });
  }
  return procs;
}

/** Working directory and executable paths by pid (lsof -d cwd,txt). */
interface Files {
  cwd: string | null;
  txt: string[];
}

async function paths(pids?: number[]): Promise<Map<number, Files>> {
  const args = ['-n', '-P', '-w', '-a', '-d', 'cwd,txt', '-Fpfn'];
  if (pids) args.push('-p', pids.join(','));
  else args.push('-u', String(userInfo().uid));
  const out = await run('/usr/sbin/lsof', args);
  const map = new Map<number, Files>();
  let pid = 0;
  let fd = '';
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      pid = Number(line.slice(1));
      map.set(pid, { cwd: null, txt: [] });
    } else if (line.startsWith('f')) fd = line.slice(1);
    else if (line.startsWith('n') && pid) {
      const f = map.get(pid)!;
      if (fd === 'cwd') f.cwd = line.slice(1);
      else if (fd === 'txt') f.txt.push(line.slice(1));
    }
  }
  return map;
}

function under(p: string, root: string): boolean {
  const a = p.toLowerCase();
  const b = root.toLowerCase();
  return a === b || a.startsWith(b + '/');
}

/** The engine and every ancestor of it: never signalled. */
function ancestors(procs: Proc[]): Set<number> {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const out = new Set<number>([process.pid, process.ppid, 0, 1]);
  let cur = byPid.get(process.pid);
  while (cur && cur.ppid > 1 && !out.has(cur.ppid)) {
    out.add(cur.ppid);
    cur = byPid.get(cur.ppid);
  }
  return out;
}

/** The engine's descendants (its own git, ps, lsof, live commands). */
function engineDescendants(procs: Proc[]): Set<number> {
  const out = new Set<number>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) {
      if (!out.has(p.pid) && (p.ppid === process.pid || out.has(p.ppid)) && p.pid !== process.pid) {
        out.add(p.pid);
        grew = true;
      }
    }
  }
  return out;
}

/** Protected pids and all their descendants. */
function protectedSet(procs: Proc[], root: string): Set<number> {
  const roots = protectedPids.get(root) ?? new Set<number>();
  const out = new Set<number>(roots);
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs) {
      if (!out.has(p.pid) && out.has(p.ppid)) {
        out.add(p.pid);
        grew = true;
      }
    }
  }
  return out;
}

/**
 * The pids among `procs` that belong to the run rooted at `root` (resolved).
 * `members` are the pids running under this run's own sandbox profile (null
 * when the helper is unavailable). The engine's descendants are spared
 * unless they run under the run's sandbox or carry its environment markers.
 */
function belonging(procs: Proc[], files: Map<number, Files>, root: string, spare: Set<number>, members: Set<number> | null, engine: Set<number>): number[] {
  const markers = [`HOME=${join(root, 'home')}`, `TMPDIR=${join(root, 'tmp')}/`];
  const live = liveGroups.get(root) ?? new Set<number>();
  const out: number[] = [];
  for (const p of procs) {
    if (spare.has(p.pid) || live.has(p.pgid)) continue;
    const sandboxed = members?.has(p.pid) ?? false;
    const env = markers.some((m) => p.command.includes(` ${m}`) || p.command.startsWith(m));
    if (engine.has(p.pid) && !sandboxed && !env) continue;
    if (sandboxed || env) {
      out.push(p.pid);
      continue;
    }
    const f = files.get(p.pid) ?? { cwd: null, txt: [] };
    const exeUnder = f.txt.some((x) => under(x, root));
    const cwdUnder = f.cwd !== null && under(f.cwd, root);
    const noTty = p.tty === '??' || p.tty === '-';
    if (exeUnder || (cwdUnder && noTty)) out.push(p.pid);
  }
  return out;
}

async function scan(root: string, pids?: number[]): Promise<number[]> {
  const all = await processes();
  const spare = new Set([...ancestors(all), ...protectedSet(all, root)]);
  const procs = pids ? all.filter((p) => pids.includes(p.pid)) : all;
  if (procs.length === 0) return [];
  // sandbox_check needs both probe paths to exist; an agent may have removed tmp.
  for (const d of ['tmp', 'ctl']) mkdirSync(join(root, d), { recursive: true });
  const candidates = procs.filter((p) => !spare.has(p.pid)).map((p) => p.pid);
  const members = await sandboxMembers(candidates, join(root, 'tmp'), join(root, 'ctl'));
  const files = await paths(pids ?? undefined);
  return belonging(procs, files, root, spare, members, engineDescendants(all));
}

/** Signals each pid only after checking, just before, that it still belongs to the run. */
async function signalVerified(root: string, pids: number[], sig: 'SIGTERM' | 'SIGKILL'): Promise<number[]> {
  if (pids.length === 0) return [];
  const still = await scan(root, pids);
  const hit: number[] = [];
  for (const pid of still) {
    try {
      process.kill(pid, sig);
      hit.push(pid);
    } catch {
      // already gone
    }
  }
  return hit;
}

const TERM_GRACE_MS = 1000;

/**
 * Kills every process that belongs to the run (see the module comment):
 * TERM, a grace of one second, then KILL for whatever is still there.
 * Returns the pids it signalled.
 */
export async function reapRun(runRoot: string): Promise<number[]> {
  const root = key(runRoot);
  const signalled = new Set<number>();
  // A daemon may fork again between passes: keep going until a scan finds nothing.
  for (let pass = 0; pass < 5; pass++) {
    const found = await scan(root);
    if (found.length === 0) break;
    for (const pid of await signalVerified(root, found, 'SIGTERM')) signalled.add(pid);
    await new Promise((r) => setTimeout(r, pass === 0 ? TERM_GRACE_MS : 100));
    for (const pid of await signalVerified(root, found, 'SIGKILL')) signalled.add(pid);
  }
  return [...signalled];
}

/**
 * Reaps the run and confirms nothing of it is left running. Tasks 9 and 13
 * call it before diffOf, commitAll and each claude tool turn. Throws when a
 * process of the run survives.
 */
export async function runQuiet(runRoot: string): Promise<void> {
  await reapRun(runRoot);
  const left = await scan(key(runRoot));
  if (left.length) throw new Error(`run processes still alive: ${left.join(', ')}`);
}
