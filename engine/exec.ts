import { spawn } from 'node:child_process';

export type Runner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/**
 * Commands that reach his accounts, his login or his machine's services.
 * Under `node --test` (NODE_TEST_CONTEXT is set) the real runner refuses
 * them, so a test that forgets to install a fake fails loudly instead of
 * talking to GitHub (test safety rule 4). Real git and sh stay allowed for
 * the bare repos tests build in their temp dirs (rule 5).
 */
const REFUSED_IN_TESTS = new Set(['gh', 'claude', 'ollama', 'security', 'caffeinate', 'osascript', 'launchctl']);

function inTestRun(): boolean {
  return !!process.env.NODE_TEST_CONTEXT;
}

/** The default Runner: actually spawns the process. */
export const realRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
    if (inTestRun() && REFUSED_IN_TESTS.has(cmd.split('/').pop() ?? cmd)) {
      reject(new Error(`${cmd} ${args.join(' ')} refused in tests: install a fake runner`));
      return;
    }
    const child = spawn(cmd, args, { cwd: opts?.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeoutMs = opts?.timeoutMs ?? 120_000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${cmd} ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });

let current: Runner = realRunner;

/** The Runner all gh/git calls currently go through: realRunner, or a fake installed by setRunner for tests. */
export function getRunner(): Runner {
  return current;
}

/** Installs a Runner for tests to fake gh/git calls. Pass realRunner to restore the default. */
export function setRunner(r: Runner): void {
  current = r;
}
