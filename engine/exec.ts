import { spawn } from 'node:child_process';

export type Runner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

/** The default Runner: actually spawns the process. */
export const realRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve, reject) => {
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
