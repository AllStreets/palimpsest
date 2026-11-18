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
 * When the sandbox helper is available, membership of the run's sandbox is
 * the only rule that authorizes a signal; the other rules apply only when
 * the helper cannot be built.
 *
 * Never matched: the engine and its ancestors, the engine's descendants
 * that neither run under the run's sandbox nor carry its markers (its own
 * git, whose HOME is not the agent's), pids the run protects
 * (protectPids: the claude CLI, Task 9) and their descendants, and the
 * process groups of commands of the run that are still live.
 *
 * Open files other than the working directory and the executable are not
 * scanned: one `lsof` of every open file of his user takes seconds.
 *
 * reapGroup() kills a finished or timed-out command's whole process group at
 * once, which a pid-by-pid reap cannot do for a process that keeps forking:
 * a group signal reaches every member at the same instant. The group is
 * signalled only while one of its members is verified to belong to the run.
 */
import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import { mkdirSync } from 'node:fs';

import { signalGroup } from '../exec.js';
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

/** The pids protected for this run (for tests and diagnostics). */
export function protectedPidsOf(runRoot: string): number[] {
  return [...(protectedPids.get(key(runRoot)) ?? [])];
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

/** Thrown by processes() when the sandbox refuses to start ps (spawn EPERM: setuid /bin/ps under macOS sandbox). */
class PsDenied extends Error {}

type Runner = (cmd: string, args: string[]) => Promise<string>;

function realRun(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 30_000 }, (err, stdout) => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (cmd === '/bin/ps' && (code === 'EPERM' || code === 'EACCES')) reject(err);
      else resolve(stdout ?? '');
    });
  });
}

let run: Runner = realRun;

/** For tests: replaces the command runner (null restores it). */
export function setReaperRunner(r: Runner | null): void {
  run = r ?? realRun;
}

/** Every process of his user, with its environment appended to the command (ps -E). Throws PsDenied when ps cannot be started. */
async function processesOrThrow(pids?: number[]): Promise<Proc[]> {
  const args = ['-wwE', '-o', 'pid=,ppid=,pgid=,tty=,command='];
  if (pids) args.push('-p', pids.join(','));
  else args.push('-U', String(userInfo().uid));
  let out: string;
  try {
    out = await run('/bin/ps', args);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') throw new PsDenied(`ps refused: ${code}`);
    throw e;
  }
  const procs: Proc[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s?(.*)$/);
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), tty: m[4], command: m[5] });
  }
  return procs;
}

/** As processesOrThrow, but a refused ps reads as no processes (the other reaper paths' old behaviour). */
async function processes(pids?: number[]): Promise<Proc[]> {
  try {
    return await processesOrThrow(pids);
  } catch (e) {
    if (e instanceof PsDenied) return [];
    throw e;
  }
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
  const live = liveGroups.get(root) ?? new Set<number>();
  const out: number[] = [];
  for (const p of procs) {
    if (spare.has(p.pid) || live.has(p.pgid)) continue;
    // With the helper, only this run's sandbox members are ever signalled: the
    // environment, executable and cwd rules never widen the set, so no
    // process of his outside the sandbox can be killed by them.
    if (members !== null) {
      if (members.has(p.pid)) out.push(p.pid);
      continue;
    }
    const sandboxed = false;
    const env = marked(p, root);
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
  // The probe is ctl: no sandboxed process can rename, replace or symlink it.
  mkdirSync(join(root, 'ctl'), { recursive: true });
  const candidates = procs.filter((p) => !spare.has(p.pid)).map((p) => p.pid);
  const members = await sandboxMembers(candidates, join(root, 'ctl'), dirname(root));
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
const GROUP_GRACE_MS = 200;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Whether a `ps -E` line carries the run's child environment markers (childEnv). */
function marked(p: Proc, root: string): boolean {
  return [`HOME=${join(root, 'home')}`, `TMPDIR=${join(root, 'tmp')}/`].some((m) => p.command.includes(` ${m}`) || p.command.startsWith(m));
}

/** reapGroup without ps: TERM to the group, a short grace, then KILL until the group is gone. Never throws. */
async function reapGroupBlind(pgid: number): Promise<number[]> {
  if (!signalGroup(pgid, 'SIGTERM')) return [];
  await sleep(GROUP_GRACE_MS);
  for (let i = 0; i < 20; i++) {
    if (!signalGroup(pgid, 'SIGKILL')) break;
    await sleep(50);
  }
  return [];
}

/**
 * Kills what is left of one command's process group (`pgid`, the command's
 * own pid): TERM to the whole group, a short grace, then KILL to the group
 * until it is empty. Before the first signal a member of the group must be
 * verified as the run's: one listed with the run's environment markers in
 * the same `ps` snapshot, or one the sandbox helper finds under the run's
 * profile (a member that forks faster than the helper can look is looked
 * for again in fresh snapshots). Every later signal needs the group still
 * listed: a process id is never reused while a group of that id exists, so
 * the group signalled is the command's own. The caller marks the group no
 * longer live first. Returns the pids that were in the group when it was
 * signalled.
 */
export async function reapGroup(runRoot: string, pgid: number | null): Promise<number[]> {
  if (pgid === null || !Number.isInteger(pgid) || pgid <= 1) return [];
  const root = key(runRoot);
  const hit = new Set<number>();
  let unverified = 0;
  let verified = false;
  let signals = 0;
  for (let pass = 0; pass < 100; pass++) {
    let all: Proc[];
    try {
      all = await processesOrThrow();
    } catch (e) {
      if (!(e instanceof PsDenied)) throw e;
      // ps cannot start in this sandbox: nothing can be listed or verified, so
      // fall back to the command's own process group (pgid is its own pid).
      return reapGroupBlind(pgid);
    }
    const spare = new Set([...ancestors(all), ...protectedSet(all, root)]);
    const members = all.filter((p) => p.pgid === pgid && !spare.has(p.pid));
    const group = members.map((p) => p.pid);
    if (group.length === 0) break;
    // Once verified, the group stays the run's while each snapshot still finds it: its id cannot be reused meanwhile.
    if (!verified && !members.some((p) => marked(p, root))) {
      mkdirSync(join(root, 'ctl'), { recursive: true });
      const sandboxed = await sandboxMembers(group, join(root, 'ctl'), dirname(root));
      if (sandboxed === null) break;
      // Every member listed may have forked and exited before the helper looked: look again at a fresh snapshot.
      if (!group.some((pid) => sandboxed.has(pid))) {
        unverified += 1;
        if (unverified >= 60) break;
        continue;
      }
    }
    verified = true;
    if (!signalGroup(pgid, signals === 0 ? 'SIGTERM' : 'SIGKILL')) break;
    for (const pid of group) hit.add(pid);
    await sleep(signals === 0 ? GROUP_GRACE_MS : 50);
    signals += 1;
  }
  return [...hit];
}

/**
 * Kills every process that belongs to the run (see the module comment):
 * TERM, a grace of one second, then KILL for whatever is still there.
 * Returns the pids it signalled.
 */
export async function reapRun(runRoot: string): Promise<number[]> {
  return (await reapPasses(key(runRoot))).signalled;
}

/** reapRun's passes; `clean` when the last scan found nothing of the run. */
async function reapPasses(root: string): Promise<{ signalled: number[]; clean: boolean }> {
  const signalled = new Set<number>();
  // A daemon may fork again between passes: keep going until a scan finds nothing.
  for (let pass = 0; pass < 5; pass++) {
    const found = await scan(root);
    if (found.length === 0) return { signalled: [...signalled], clean: true };
    for (const pid of await signalVerified(root, found, 'SIGTERM')) signalled.add(pid);
    await new Promise((r) => setTimeout(r, pass === 0 ? TERM_GRACE_MS : 100));
    for (const pid of await signalVerified(root, found, 'SIGKILL')) signalled.add(pid);
  }
  return { signalled: [...signalled], clean: false };
}

/**
 * Reaps the run until a scan finds nothing of it, or until a few rounds have
 * failed to clear it: a process just killed can still be listed for a
 * moment, and a straggler may have forked once more. Returns the pids it
 * signalled and the pids still there at the end (live commands' groups are
 * never counted).
 */
export async function settleRun(runRoot: string): Promise<{ reaped: number[]; left: number[] }> {
  const root = key(runRoot);
  const first = await reapPasses(root);
  const reaped = new Set(first.signalled);
  // A pass that found nothing to kill has already confirmed the run quiet.
  if (first.clean) return { reaped: [...reaped], left: [] };
  let left = await scan(root);
  for (let round = 0; left.length && round < 3; round++) {
    await sleep(250);
    for (const pid of await reapRun(runRoot)) reaped.add(pid);
    left = await scan(root);
  }
  return { reaped: [...reaped], left };
}

/**
 * Reaps the run and confirms nothing of it is left running. Tasks 9 and 13
 * call it before diffOf, commitAll and each claude tool turn. Returns the
 * pids it had to kill (for the run log); throws only when a process of the
 * run survives every round of settleRun.
 */
export async function runQuiet(runRoot: string): Promise<number[]> {
  const { reaped, left } = await settleRun(runRoot);
  if (left.length) throw new Error(`run processes still alive: ${left.join(', ')}`);
  return reaped;
}
