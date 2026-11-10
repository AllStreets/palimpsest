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

/* ------------------------------------------------------------------ */
/* The Spawner (Task 6): long-lived children streamed line by line.    */
/* ------------------------------------------------------------------ */

export type SpawnLine = { stream: 'stdout' | 'stderr'; line: string };

export type SpawnOpts = {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  /** Start from an empty environment plus `env`, inheriting nothing from the engine. */
  clearEnv?: boolean;
};

export type Spawned = {
  /** Also the process group id: children start as group leaders. Null when the spawn failed. */
  pid: number | null;
  /** stdout and stderr lines in arrival order; ends when both streams close. */
  lines: AsyncIterable<SpawnLine>;
  /** Signals the whole process group (default SIGTERM), so the command's own children die with it. */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
  /** `error` is set only when the process could not be started (missing binary, bad cwd). */
  done: Promise<{ code: number | null; signal: string | null; error?: string }>;
};

export type Spawner = (cmd: string, args: string[], opts: SpawnOpts) => Spawned;

/**
 * Keys no child ever inherits from the engine's own environment (global
 * constraint: the claude child never sees them). A caller that really
 * means to pass one names it in `opts.env`.
 */
export const NEVER_INHERITED = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
] as const;

/**
 * Under `node --test` the spawner refuses the same commands as the runner,
 * whether named directly or as an argument of a wrapper such as
 * `sandbox-exec ... claude` or `env gh ...`.
 */
function refusedInTests(cmd: string, args: string[]): string | null {
  if (!inTestRun()) return null;
  for (const word of [cmd, ...args]) {
    const base = word.split('/').pop() ?? word;
    if (REFUSED_IN_TESTS.has(base)) return base;
  }
  return null;
}

function childEnv(opts: SpawnOpts): Record<string, string> {
  const env: Record<string, string> = {};
  if (!opts.clearEnv) {
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !(NEVER_INHERITED as readonly string[]).includes(k)) env[k] = v;
    }
  }
  return { ...env, ...(opts.env ?? {}) };
}

/** A small push queue that is also an AsyncIterable. */
function lineQueue() {
  const buffered: SpawnLine[] = [];
  const waiting: ((r: IteratorResult<SpawnLine>) => void)[] = [];
  let closed = false;
  return {
    push(l: SpawnLine) {
      if (closed) return;
      const w = waiting.shift();
      if (w) w({ value: l, done: false });
      else buffered.push(l);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const w of waiting.splice(0)) w({ value: undefined, done: true });
    },
    iterable: {
      [Symbol.asyncIterator](): AsyncIterator<SpawnLine> {
        return {
          next: () => {
            const l = buffered.shift();
            if (l) return Promise.resolve({ value: l, done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((r) => waiting.push(r));
          },
        };
      },
    } as AsyncIterable<SpawnLine>,
  };
}

/** How long after a SIGTERM the spawner sends SIGKILL to the whole group. */
export const KILL_GRACE_MS = 2000;

function signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    /* the group is already gone */
  }
}

/** The default Spawner: a real child in its own process group. */
export const realSpawner: Spawner = (cmd, args, opts) => {
  const refused = refusedInTests(cmd, args);
  if (refused) throw new Error(`${cmd} ${args.join(' ')} refused in tests (${refused}): install a fake spawner`);

  const queue = lineQueue();
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: childEnv(opts),
    detached: true,
    stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const pid = child.pid ?? null;
  let escalation: NodeJS.Timeout | null = null;

  // Node emits the child's 'close' from inside the last stream's own 'close',
  // before listeners added here run, so partial lines are flushed on 'end'
  // and once more before the queue closes.
  const partial = { stdout: '', stderr: '' };
  const flush = (stream: 'stdout' | 'stderr') => {
    if (partial[stream]) queue.push({ stream, line: partial[stream] });
    partial[stream] = '';
  };
  const finish = () => {
    flush('stdout');
    flush('stderr');
    queue.close();
  };
  let open = 2;
  for (const stream of ['stdout', 'stderr'] as const) {
    const source = child[stream]!;
    source.setEncoding('utf8');
    source.on('data', (chunk: string) => {
      partial[stream] += chunk;
      let nl = partial[stream].indexOf('\n');
      while (nl !== -1) {
        queue.push({ stream, line: partial[stream].slice(0, nl).replace(/\r$/, '') });
        partial[stream] = partial[stream].slice(nl + 1);
        nl = partial[stream].indexOf('\n');
      }
    });
    source.on('end', () => flush(stream));
    source.on('close', () => {
      open -= 1;
      if (open === 0) finish();
    });
  }

  if (opts.stdin !== undefined && child.stdin) {
    child.stdin.on('error', () => {
      /* the child closed stdin early; nothing to do */
    });
    child.stdin.end(opts.stdin);
  }

  const done = new Promise<{ code: number | null; signal: string | null; error?: string }>((resolve) => {
    child.on('error', (err) => {
      if (pid !== null) return; // errors after a good start (a failed kill) are not the end
      queue.push({ stream: 'stderr', line: `spawn failed: ${err.message}` });
      queue.close();
      resolve({ code: null, signal: null, error: err.message });
    });
    child.on('close', (code, signal) => {
      finish();
      resolve({ code, signal });
    });
  });

  return {
    pid,
    lines: queue.iterable,
    kill(signal = 'SIGTERM') {
      if (pid === null) return;
      signalGroup(pid, signal);
      // A child forked a moment before the TERM can miss it and keep the
      // pipes open, so a TERM is always followed by a KILL to the group.
      if (signal === 'SIGTERM' && !escalation) {
        escalation = setTimeout(() => signalGroup(pid, 'SIGKILL'), KILL_GRACE_MS);
        escalation.unref();
      }
    },
    done,
  };
};

let currentSpawner: Spawner = realSpawner;

/** The Spawner every model backend, broker command and check goes through: realSpawner, or a fake from setSpawner. */
export function getSpawner(): Spawner {
  return currentSpawner;
}

/** Installs a Spawner for tests. Pass realSpawner to restore the default. */
export function setSpawner(s: Spawner): void {
  currentSpawner = s;
}
