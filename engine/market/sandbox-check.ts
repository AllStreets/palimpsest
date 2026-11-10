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
 * A pid is a member of the run when it is sandboxed, its profile allows a
 * write to `<runRoot>/tmp` (only this run's tool and CLI profiles allow
 * that) and denies a write to `<runRoot>/ctl` (both of this run's profiles
 * deny it, while any permissive sandbox would allow it). The check needs
 * both paths to exist; the caller creates them first.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const SOURCE = `#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
extern int sandbox_check(pid_t pid, const char *operation, int type, ...);
#define FILTER_NONE 0
#define FILTER_PATH 1
#define NO_REPORT 0x40000000
/* argv: allowPath denyPath pid...; prints "pid sandboxed allowed denied" (1 = true) */
int main(int argc, char **argv) {
  if (argc < 3) return 2;
  for (int i = 3; i < argc; i++) {
    pid_t pid = (pid_t)atoi(argv[i]);
    if (pid <= 1) continue;
    int sandboxed = sandbox_check(pid, NULL, FILTER_NONE | NO_REPORT) == 1;
    int allowed = sandbox_check(pid, "file-write-create", FILTER_PATH | NO_REPORT, argv[1]) == 0;
    int denied = sandbox_check(pid, "file-write-create", FILTER_PATH | NO_REPORT, argv[2]) == 1;
    printf("%d %d %d %d\\n", (int)pid, sandboxed, allowed, denied);
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

/** The helper's path, compiling it on first use. Null when it cannot be built (no compiler, not a Mac). */
export async function sandboxCheckBin(): Promise<string | null> {
  if (built !== undefined) return built;
  if (process.platform !== 'darwin') return (built = null);
  const hash = createHash('sha256').update(SOURCE).digest('hex').slice(0, 16);
  const dir = join(realpathSync.native(tmpdir()), `palimpsest-${userInfo().uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== userInfo().uid) return (built = null);
  chmodSync(dir, 0o700);
  const bin = join(dir, `sandbox-check-${hash}`);
  if (!existsSync(bin)) {
    const src = join(dir, `sandbox-check-${hash}-${process.pid}.c`);
    const tmp = `${bin}.${process.pid}.tmp`;
    writeFileSync(src, SOURCE, { mode: 0o600 });
    const r = await run('/usr/bin/cc', ['-O2', '-o', tmp, src]);
    rmSync(src, { force: true });
    if (r.code !== 0 || !existsSync(tmp)) {
      rmSync(tmp, { force: true });
      return (built = null);
    }
    chmodSync(tmp, 0o500);
    renameSync(tmp, bin);
  }
  return (built = bin);
}

/**
 * The pids among `pids` that run under a profile which allows writes to
 * `allowPath` and denies them to `denyPath`. Null when the helper is
 * unavailable (the caller falls back to its other rules).
 */
export async function sandboxMembers(pids: number[], allowPath: string, denyPath: string): Promise<Set<number> | null> {
  const bin = await sandboxCheckBin();
  if (!bin) return null;
  const out = new Set<number>();
  for (let i = 0; i < pids.length; i += 500) {
    const r = await run(bin, [allowPath, denyPath, ...pids.slice(i, i + 500).map(String)]);
    for (const line of r.stdout.split('\n')) {
      const [pid, sandboxed, allowed, denied] = line.trim().split(' ').map(Number);
      if (pid && sandboxed === 1 && allowed === 1 && denied === 1) out.add(pid);
    }
  }
  return out;
}
