import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { getSpawner, KILL_GRACE_MS, realSpawner, setSpawner, signalGroup, type Spawner } from '../engine/exec.js';

afterEach(() => {
  setSpawner(realSpawner);
});

async function collect(lines: AsyncIterable<{ stream: 'stdout' | 'stderr'; line: string }>) {
  const out: { stream: 'stdout' | 'stderr'; line: string }[] = [];
  for await (const l of lines) out.push(l);
  return out;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(fn: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return fn();
}

test('spawner streams stdout and stderr lines and reports exit', async () => {
  const child = realSpawner('/bin/sh', ['-c', 'printf "a\\nb\\n"; printf "c\\n" >&2'], {});
  assert.equal(typeof child.pid, 'number');
  const lines = await collect(child.lines);
  const done = await child.done;
  assert.deepEqual(
    lines.filter((l) => l.stream === 'stdout').map((l) => l.line),
    ['a', 'b'],
  );
  assert.deepEqual(
    lines.filter((l) => l.stream === 'stderr').map((l) => l.line),
    ['c'],
  );
  assert.equal(done.code, 0);
  assert.equal(done.signal, null);
});

test('spawner keeps a last line with no newline and passes stdin', async () => {
  const child = realSpawner('/bin/sh', ['-c', 'cat; printf "tail"'], { stdin: 'in\n' });
  const lines = await collect(child.lines);
  assert.deepEqual(
    lines.map((l) => l.line),
    ['in', 'tail'],
  );
  assert.equal((await child.done).code, 0);
});

test('kill ends done with a signal and kills the group', async () => {
  const child = realSpawner('/bin/sh', ['-c', 'sleep 30 & echo $!; sleep 30'], {});
  const it = child.lines[Symbol.asyncIterator]();
  const first = await it.next();
  const bg = Number((first.value as { line: string }).line);
  assert.ok(bg > 0, 'background pid printed');
  assert.ok(alive(bg), 'background sleep is running');
  child.kill();
  const done = await child.done;
  assert.equal(done.signal, 'SIGTERM');
  assert.equal(done.code, null);
  assert.ok(await until(() => !alive(bg)), 'the background sleep died with its group');
  assert.ok(await until(() => !alive(child.pid as number)), 'the shell is gone');
});

test('kill with SIGKILL ends done with SIGKILL', async () => {
  const child = realSpawner('/bin/sh', ['-c', 'trap "" TERM; sleep 30'], {});
  await new Promise((r) => setTimeout(r, 100));
  child.kill('SIGKILL');
  const done = await child.done;
  assert.equal(done.signal, 'SIGKILL');
});

test('clearEnv drops the parent environment', async () => {
  process.env.PALIMPSEST_EXEC_TEST_PARENT = 'leak';
  try {
    const child = realSpawner('/usr/bin/env', [], { clearEnv: true, env: { ONLY: 'one', ALSO: 'two' } });
    const lines = (await collect(child.lines)).filter((l) => l.stream === 'stdout').map((l) => l.line);
    await child.done;
    assert.deepEqual(lines.sort(), ['ALSO=two', 'ONLY=one']);
  } finally {
    delete process.env.PALIMPSEST_EXEC_TEST_PARENT;
  }
});

test('the inherited environment never carries the Anthropic keys', async () => {
  const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'];
  const saved = keys.map((k) => process.env[k]);
  for (const k of keys) process.env[k] = 'dummy-test-value';
  process.env.PALIMPSEST_EXEC_TEST_PARENT = 'kept';
  try {
    const child = realSpawner('/usr/bin/env', [], {});
    const lines = (await collect(child.lines)).map((l) => l.line);
    await child.done;
    assert.ok(lines.includes('PALIMPSEST_EXEC_TEST_PARENT=kept'));
    for (const k of keys) assert.ok(!lines.some((l) => l.startsWith(`${k}=`)), `${k} not inherited`);
  } finally {
    keys.forEach((k, n) => {
      if (saved[n] === undefined) delete process.env[k];
      else process.env[k] = saved[n];
    });
    delete process.env.PALIMPSEST_EXEC_TEST_PARENT;
  }
});

test('a missing command ends done with an error and no pid', async () => {
  const child = realSpawner('/nonexistent/palimpsest-no-such-cmd', [], {});
  const lines = await collect(child.lines);
  const done = await child.done;
  assert.equal(done.code, null);
  assert.ok(done.error);
  assert.ok(lines.some((l) => l.stream === 'stderr'));
  child.kill();
});

test('the real spawner refuses claude, ollama and gh under node --test', () => {
  assert.throws(() => realSpawner('claude', ['-p', 'hi'], {}), /refused in tests/);
  assert.throws(() => realSpawner('/opt/homebrew/bin/ollama', ['list'], {}), /refused in tests/);
  assert.throws(() => realSpawner('/usr/bin/sandbox-exec', ['-f', 'p.sb', '/usr/local/bin/claude', '-p'], {}), /refused in tests/);
  assert.throws(() => realSpawner('/usr/bin/env', ['gh', '--version'], {}), /refused in tests/);
});

// Harmless subcommands on purpose: if the guard ever regressed, nothing sensitive would run.
test('the real spawner refuses refused commands inside shell wrappers', () => {
  assert.throws(() => realSpawner('/bin/sh', ['-c', 'claude --version'], {}), /refused in tests/);
  assert.throws(() => realSpawner('bash', ['-c', '"gh" --version'], {}), /refused in tests/);
  assert.throws(() => realSpawner('/bin/sh', ['-c', 'true;/opt/homebrew/bin/ollama --version'], {}), /refused in tests/);
  assert.throws(() => realSpawner('/bin/sh', ['-c', 'echo x|security help'], {}), /refused in tests/);
  assert.throws(() => realSpawner('/bin/sh', ['-c', '(launchctl help)&&true'], {}), /refused in tests/);
  assert.throws(() => realSpawner('/bin/sh', ['-c', "x=$(caffeinate -t 1 'true')"], {}), /refused in tests/);
  assert.throws(() => realSpawner('/bin/sh', ['-c', 'echo `osascript -e 1`'], {}), /refused in tests/);
});

/** Records every process.kill call while fn runs. */
async function recordingKills<T>(fn: (calls: [number, string | number | undefined][]) => Promise<T>): Promise<T> {
  const real = process.kill;
  const calls: [number, string | number | undefined][] = [];
  process.kill = ((pid: number, sig?: string | number) => {
    calls.push([pid, sig]);
    return real.call(process, pid, sig);
  }) as typeof process.kill;
  try {
    return await fn(calls);
  } finally {
    process.kill = real;
  }
}

test('kill() after done sends nothing', async () => {
  await recordingKills(async (calls) => {
    const child = realSpawner('/bin/sh', ['-c', 'exit 0'], {});
    await collect(child.lines);
    await child.done;
    child.kill();
    child.kill('SIGKILL');
    assert.deepEqual(calls, []);
  });
});

test('the delayed SIGKILL is cleared once the group is gone', async () => {
  await recordingKills(async (calls) => {
    const child = realSpawner('/bin/sh', ['-c', 'sleep 30'], {});
    await new Promise((r) => setTimeout(r, 100));
    child.kill();
    await child.done;
    await new Promise((r) => setTimeout(r, KILL_GRACE_MS + 300));
    assert.deepEqual(
      calls.map((c) => c[1]),
      ['SIGTERM'],
    );
  });
});

test('signalGroup refuses anything but an integer pgid above 1', () => {
  for (const bad of [0, 1, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(signalGroup(bad, 'SIGTERM'), false, String(bad));
  }
});

test('done resolves soon after the leader exits even when a grandchild holds stdout', async () => {
  const start = Date.now();
  const child = realSpawner('/bin/sh', ['-c', '(trap "" TERM; sleep 30) & echo $!; exit 3'], {});
  const it = child.lines[Symbol.asyncIterator]();
  const bg = Number(((await it.next()).value as { line: string }).line);
  assert.ok(alive(bg));
  const done = await child.done;
  assert.equal(done.code, 3);
  assert.ok(Date.now() - start < KILL_GRACE_MS + 2000, 'resolved within the grace');
  assert.equal((await it.next()).done, true, 'the line stream ended');
  assert.ok(await until(() => !alive(bg)), 'the grandchild was killed with its group');
});

test('maxMs caps a child by wall clock', async () => {
  const start = Date.now();
  const child = realSpawner('/bin/sh', ['-c', 'sleep 30'], { maxMs: 200 });
  const done = await child.done;
  assert.equal(done.timedOut, true);
  assert.equal(done.signal, 'SIGTERM');
  assert.ok(Date.now() - start < 3000);
});

test('the line queue is bounded and marks what it dropped', async () => {
  const child = realSpawner('/bin/sh', ['-c', 'i=0; while [ $i -lt 20 ]; do echo $i; i=$((i+1)); done'], { maxBufferedLines: 5 });
  await child.done;
  const lines = await collect(child.lines);
  assert.deepEqual(
    lines.slice(0, 5).map((l) => l.line),
    ['0', '1', '2', '3', '4'],
  );
  assert.equal(lines.length, 6);
  assert.match(lines[5].line, /15 lines dropped/);
});

test('a line with no newline is cut at the line limit', async () => {
  const child = realSpawner('/bin/sh', ['-c', 'head -c 2000000 /dev/zero | tr "\\0" x'], {});
  const lines = await collect(child.lines);
  await child.done;
  assert.ok(lines.length >= 2);
  assert.ok(lines.every((l) => l.line.length <= 1024 * 1024));
});

test('setSpawner installs a fake and getSpawner returns it', () => {
  const fake: Spawner = () => ({
    pid: 1,
    lines: (async function* () {})(),
    kill() {},
    done: Promise.resolve({ code: 0, signal: null }),
  });
  setSpawner(fake);
  assert.equal(getSpawner(), fake);
  setSpawner(realSpawner);
  assert.equal(getSpawner(), realSpawner);
});
