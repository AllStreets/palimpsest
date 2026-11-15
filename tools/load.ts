/**
 * A synthetic load for the load-sensitive tests (Phase 5 Task 18): one busy
 * loop per performance core for as long as the command it wraps runs, then
 * the command's own exit status. No GPU, no port, no file: the loops spin in
 * worker threads of this process and the command runs as its child.
 *
 *   node --no-warnings --import tsx tools/load.ts npm test
 *
 * LOAD_THREADS overrides the count. The city track's tools/perf.ts is never
 * used for this: it holds the GPU and its own port.
 */
import { execFileSync, spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';

/** The Mac's performance cores (`hw.perflevel0.physicalcpu`), else every core Node sees. */
export function performanceCores(): number {
  const set = Number(process.env.LOAD_THREADS);
  if (Number.isInteger(set) && set > 0) return set;
  try {
    const n = Number(execFileSync('/usr/sbin/sysctl', ['-n', 'hw.perflevel0.physicalcpu'], { encoding: 'utf8' }).trim());
    if (Number.isInteger(n) && n > 0) return n;
  } catch {
    // not Apple silicon, or sysctl refused: fall through
  }
  return availableParallelism();
}

/** Busy loops on `n` threads; stop() ends them. */
export function busyLoops(n: number): { stop(): Promise<void> } {
  const body = 'let x = 0; for (;;) { x = (x * 1103515245 + 12345) % 2147483648; }';
  const workers = Array.from({ length: n }, () => new Worker(body, { eval: true }));
  return {
    async stop() {
      await Promise.all(workers.map((w) => w.terminate()));
    },
  };
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    console.error('usage: node --import tsx tools/load.ts <command> [args...]');
    process.exit(2);
  }
  const n = performanceCores();
  const load = busyLoops(n);
  console.error(`load: ${n} busy loops while ${[cmd, ...args].join(' ')} runs`);
  const child = spawn(cmd, args, { stdio: 'inherit' });
  const code = await new Promise<number>((resolve) => {
    child.on('error', (err) => {
      console.error(`load: ${cmd} could not start: ${err.message}`);
      resolve(127);
    });
    child.on('exit', (c, sig) => resolve(c ?? (sig ? 128 : 1)));
  });
  await load.stop();
  process.exit(code);
}

if (import.meta.url === `file://${process.argv[1]}`) void main();
