/**
 * Which processes run under a given run's sandbox profile (Task 8, reaper).
 *
 * A process cannot drop its sandbox, so this test cannot be evaded by
 * clearing the environment, changing directory or exec-ing another binary.
 * libsystem_sandbox's `sandbox_check(pid, op, SANDBOX_FILTER_PATH, path)`
 * asks the kernel whether that process's profile allows an operation; node
 * cannot call it, so a tiny C helper is compiled once with the system `cc`
 * into the engine user's private temp folder (mode 0700) and reused.
 *
 * A pid is a member of the run when it is sandboxed and its profile allows
 * reading `<runRoot>/ctl`, denies creating there, and denies reading the
 * runs directory above it. Only this run's tool and CLI profiles behave
 * that way: another run's profile cannot read this ctl, a permissive
 * sandbox would allow the write, and a read-only system sandbox (such as
 * XprotectService, which reads everything) would allow reading the runs
 * directory. ctl is the probe
 * because no sandboxed process can rename, replace or symlink it (both
 * profiles deny writes to it and the run root); `<runRoot>/tmp` could be
 * swapped for a symlink, which Seatbelt would resolve.
 *
 * The helper is compiled afresh by each engine process into a new file in
 * the user's private temp folder; an existing file is never reused.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const SOURCE = `#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
extern int sandbox_check(pid_t pid, const char *operation, int type, ...);
#define FILTER_NONE 0
#define FILTER_PATH 1
#define NO_REPORT 0x40000000
/* argv: ctlPath runsPath pid...; prints "pid sandboxed readAllowed writeDenied runsDenied" (1 = true) */
int main(int argc, char **argv) {
  if (argc < 3) return 2;
  for (int i = 3; i < argc; i++) {
    pid_t pid = (pid_t)atoi(argv[i]);
    if (pid <= 1) continue;
    int sandboxed = sandbox_check(pid, NULL, FILTER_NONE | NO_REPORT) == 1;
    int allowed = sandbox_check(pid, "file-read-data", FILTER_PATH | NO_REPORT, argv[1]) == 0;
    int denied = sandbox_check(pid, "file-write-create", FILTER_PATH | NO_REPORT, argv[1]) == 1;
    int runsDenied = sandbox_check(pid, "file-read-data", FILTER_PATH | NO_REPORT, argv[2]) == 1;
    printf("%d %d %d %d %d\\n", (int)pid, sandboxed, allowed, denied, runsDenied);
  }
  return 0;
}
`;

let built: string | null | undefined;

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }, (err, stdout) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout ?? '' });
    });
  });
}

/** The helper's path, compiled afresh on first use in this process. Null when it cannot be built (no compiler, not a Mac). */
export async function sandboxCheckBin(): Promise<string | null> {
  if (built !== undefined) return built;
  if (process.platform !== 'darwin') return (built = null);
  const uid = userInfo().uid;
  const dir = join(realpathSync.native(tmpdir()), `palimpsest-${uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid) return (built = null);
  chmodSync(dir, 0o700);
  // Old builds of other engine processes are removed, never reused.
  for (const f of readdirSync(dir)) {
    if (!f.startsWith('sandbox-check-')) continue;
    const pid = Number(f.split('-')[2]);
    if (pid === process.pid || !alive(pid)) rmSync(join(dir, f), { force: true });
  }
  const stem = join(dir, `sandbox-check-${process.pid}-${randomBytes(6).toString('hex')}`);
  const src = `${stem}.c`;
  writeFileSync(src, SOURCE, { mode: 0o600, flag: 'wx' });
  const r = await run('/usr/bin/cc', ['-O2', '-o', stem, src]);
  rmSync(src, { force: true });
  let ok = false;
  try {
    const b = lstatSync(stem);
    ok = r.code === 0 && b.isFile() && !b.isSymbolicLink() && b.uid === uid;
  } catch {
    ok = false;
  }
  if (!ok) {
    rmSync(stem, { force: true });
    return (built = null);
  }
  chmodSync(stem, 0o500);
  return (built = stem);
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * The pids among `pids` that run under a profile which allows reading
 * `ctlPath` and denies creating there. Null when the helper is
 * unavailable (the caller falls back to its other rules).
 */
export async function sandboxMembers(pids: number[], ctlPath: string, runsPath: string): Promise<Set<number> | null> {
  const bin = await sandboxCheckBin();
  if (!bin) return null;
  const out = new Set<number>();
  for (let i = 0; i < pids.length; i += 500) {
    const r = await run(bin, [ctlPath, runsPath, ...pids.slice(i, i + 500).map(String)]);
    for (const line of r.stdout.split('\n')) {
      const [pid, sandboxed, allowed, denied, runsDenied] = line.trim().split(' ').map(Number);
      if (pid && sandboxed === 1 && allowed === 1 && denied === 1 && runsDenied === 1) out.add(pid);
    }
  }
  return out;
}
