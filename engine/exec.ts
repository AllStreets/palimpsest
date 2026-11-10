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
  /** Wall-clock cap: past it the group gets SIGTERM (then SIGKILL) and done reports `timedOut`. */
  maxMs?: number;
  /** Lines held for a slow reader before newer ones are dropped (with a marker). Default MAX_BUFFERED_LINES. */
  maxBufferedLines?: number;
};

export type SpawnDone = { code: number | null; signal: string | null; error?: string; timedOut?: boolean };

export type Spawned = {
  /** Also the process group id: children start as group leaders. Null when the spawn failed. */
  pid: number | null;
  /** stdout and stderr lines in arrival order; ends when the child is done. */
  lines: AsyncIterable<SpawnLine>;
  /** Signals the whole process group (default SIGTERM, escalating to SIGKILL). A no-op once done. */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
  /** `error` is set only when the process could not be started (missing binary, bad cwd). */
  done: Promise<SpawnDone>;
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

/** How long after a SIGTERM the spawner sends SIGKILL to the group, and how long done waits for the pipes after the leader exits. */
export const KILL_GRACE_MS = 2000;
/** Default bound on lines held for a slow reader. */
export const MAX_BUFFERED_LINES = 10_000;
/** A line longer than this is cut and emitted in pieces. */
export const MAX_LINE_CHARS = 1024 * 1024;

/**
 * Under `node --test` the spawner refuses the same commands as the runner,
 * whether named directly, as an argument of a wrapper (`sandbox-exec ...
 * claude`, `env gh`) or inside a shell string (`sh -c 'x; claude -p'`):
 * every argument is split on whitespace, shell operators and quotes and
 * every token's basename is checked.
 */
function refusedInTests(cmd: string, args: string[]): string | null {
  if (!inTestRun()) return null;
  for (const word of [cmd, ...args]) {
    for (const token of word.split(/[\s;&|()<>'"`$={}]+/)) {
      const base = token.split('/').pop() ?? token;
      if (REFUSED_IN_TESTS.has(base)) return base;
    }
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

/**
 * Sends a signal to a process group. Refuses anything but an integer pgid
 * above 1 (0 and 1 would mean our own group or init). Returns whether the
 * signal was sent.
 */
export function signalGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  if (!Number.isInteger(pgid) || pgid <= 1) return false;
  try {
    process.kill(-pgid, signal);
    return true;
  } catch {
    return false; // the group is already gone
  }
}

/** A bounded push queue that is also an AsyncIterable. Past the limit new lines are dropped and counted; the count is reported as a marker line when room frees or at close. */
function lineQueue(limit: number) {
  const buffered: SpawnLine[] = [];
  const waiting: ((r: IteratorResult<SpawnLine>) => void)[] = [];
  let closed = false;
  let dropped = 0;
  const deliver = (l: SpawnLine) => {
    const w = waiting.shift();
    if (w) w({ value: l, done: false });
    else buffered.push(l);
  };
  const marker = () => {
    if (dropped === 0) return;
    deliver({ stream: 'stderr', line: `[palimpsest] ${dropped} lines dropped: the reader fell behind` });
    dropped = 0;
  };
  return {
    push(l: SpawnLine) {
      if (closed) return;
      if (buffered.length >= limit) {
        dropped += 1;
        return;
      }
      marker();
      if (buffered.length >= limit) {
        dropped += 1;
        return;
      }
      deliver(l);
    },
    close() {
      if (closed) return;
      marker();
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

/**
 * The default Spawner: a real child in its own process group.
 *
 * The group is signalled only while there is evidence it is still ours:
 * the leader has not been reaped, or our stdio pipes are still open (a
 * member still holds them). Once both the exit and the close have
 * happened, or done has resolved, nothing is ever signalled again, so a
 * reused pgid is never hit.
 */
export const realSpawner: Spawner = (cmd, args, opts) => {
  const refused = refusedInTests(cmd, args);
  if (refused) throw new Error(`${cmd} ${args.join(' ')} refused in tests (${refused}): install a fake spawner`);

  const queue = lineQueue(Math.max(1, opts.maxBufferedLines ?? MAX_BUFFERED_LINES));
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: childEnv(opts),
    detached: true,
    stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const pid = child.pid ?? null;

  let exited: { code: number | null; signal: string | null } | null = null;
  let closed = false;
  let settled = false;
  let timedOut = false;
  const timers: NodeJS.Timeout[] = [];
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    t.unref();
    timers.push(t);
  };

  const ours = () => pid !== null && !settled && (exited === null || !closed);
  const signal = (sig: 'SIGTERM' | 'SIGKILL') => {
    if (ours()) signalGroup(pid as number, sig);
  };

  let resolveDone!: (d: SpawnDone) => void;
  const done = new Promise<SpawnDone>((r) => {
    resolveDone = r;
  });

  // Node emits the child's 'close' from inside the last stream's own 'close',
  // before listeners added here run, so partial lines are flushed on 'end'
  // and once more before the queue closes.
  const partial = { stdout: '', stderr: '' };
  const flush = (stream: 'stdout' | 'stderr') => {
    if (partial[stream]) queue.push({ stream, line: partial[stream] });
    partial[stream] = '';
  };
  const settle = (d: SpawnDone) => {
    if (settled) return;
    flush('stdout');
    flush('stderr');
    queue.close();
    settled = true;
    for (const t of timers) clearTimeout(t);
    resolveDone(timedOut ? { ...d, timedOut } : d);
  };

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
      while (partial[stream].length > MAX_LINE_CHARS) {
        queue.push({ stream, line: partial[stream].slice(0, MAX_LINE_CHARS) });
        partial[stream] = partial[stream].slice(MAX_LINE_CHARS);
      }
    });
    source.on('end', () => flush(stream));
  }

  if (opts.stdin !== undefined && child.stdin) {
    child.stdin.on('error', () => {
      /* the child closed stdin early; nothing to do */
    });
    child.stdin.end(opts.stdin);
  }

  child.on('error', (err) => {
    if (pid !== null) return; // errors after a good start (a failed kill) are not the end
    queue.push({ stream: 'stderr', line: `spawn failed: ${err.message}` });
    settle({ code: null, signal: null, error: err.message });
  });
  child.on('exit', (code, sig) => {
    exited = { code, signal: sig };
    // A member that outlives the leader and holds our pipes would keep done
    // pending forever: after the grace, kill the group while the open pipes
    // still prove it is ours, then end without waiting for them.
    later(KILL_GRACE_MS, () => {
      if (settled || closed) return;
      signal('SIGKILL');
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(exited as { code: number | null; signal: string | null });
    });
  });
  child.on('close', (code, sig) => {
    closed = true;
    settle(exited ?? { code, signal: sig });
  });

  if (opts.maxMs !== undefined && pid !== null) {
    later(Math.max(0, opts.maxMs), () => {
      if (settled) return;
      timedOut = true;
      kill('SIGTERM');
    });
  }

  let escalated = false;
  function kill(sig: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
    if (!ours()) return;
    signal(sig);
    // A child forked a moment before the TERM can miss it and keep the
    // pipes open, so a TERM is followed by a KILL while the group is ours.
    if (sig === 'SIGTERM' && !escalated) {
      escalated = true;
      later(KILL_GRACE_MS, () => signal('SIGKILL'));
    }
  }

  return { pid, lines: queue.iterable, kill, done };
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
