/**
 * An engine restart must not orphan the school's test checks: the startup
 * sweep reaps the process groups of leftover `verify-*` run roots (by run-root
 * membership, as audits are) and removes their dirs. Nothing outside the run
 * roots is touched. Temp home only.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { CHECK_MS } from '../engine/guild/checks.js';
import { MAX_TOOL_MS } from '../engine/market/broker.js';
import { paths } from '../engine/home.js';
import { failInterruptedRuns } from '../engine/market/runs.js';
import { wrap } from '../engine/market/sandbox.js';
import { verifyRunId } from '../engine/school/history.js';
import { NEEDS, outsideToolSandbox } from './tool-sandbox.js';

const noSandbox = process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') || !existsSync('/usr/bin/cc') ? 'sandbox-exec or cc is missing' : outsideToolSandbox(NEEDS.nestedSandbox);

let tempDir: string;
let saved: string | undefined;
let savedSandbox: string | undefined;
const children: ChildProcess[] = [];

beforeEach(() => {
  saved = process.env.PALIMPSEST_HOME;
  savedSandbox = process.env.PALIMPSEST_SANDBOX;
  process.env.PALIMPSEST_SANDBOX = 'on';
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'palimpsest-verify-reap-')));
  process.env.PALIMPSEST_HOME = join(tempDir, 'data');
  mkdirSync(join(tempDir, 'home'), { recursive: true });
});

afterEach(() => {
  for (const c of children.splice(0)) {
    try {
      process.kill(-(c.pid as number), 'SIGKILL');
    } catch {
      // gone
    }
    c.kill('SIGKILL');
  }
  if (saved === undefined) delete process.env.PALIMPSEST_HOME;
  else process.env.PALIMPSEST_HOME = saved;
  if (savedSandbox === undefined) delete process.env.PALIMPSEST_SANDBOX;
  else process.env.PALIMPSEST_SANDBOX = savedSandbox;
  rmSync(tempDir, { recursive: true, force: true });
});

function root(id: string): string {
  const r = join(paths().runs, id);
  for (const d of ['repo', 'tmp', 'home']) mkdirSync(join(r, d), { recursive: true });
  writeFileSync(join(r, 'repo', 'a.txt'), 'x');
  return r;
}

/** A sleeping group of its own carrying the run root's markers, as execTool's children do. */
function member(runRoot: string): number {
  const argv = wrap(['/bin/sh', '-c', 'sleep 60 & sleep 60'], 'tool', { runRoot, home: join(tempDir, 'home'), dataHome: join(tempDir, 'data'), enginePort: 9, proxyPort: 9, toolchains: [], otherPorts: [] });
  const c = spawn(argv[0], argv.slice(1), {
    detached: true,
    stdio: 'ignore',
    env: { PATH: '/usr/bin:/bin', HOME: join(runRoot, 'home'), TMPDIR: `${join(runRoot, 'tmp')}/` },
  });
  children.push(c);
  return c.pid as number;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test('startup reaps the group of a leftover verify run root and removes its dir', { skip: noSandbox }, async () => {
  const id = verifyRunId('acme/widgets', 'a'.repeat(40));
  const vroot = root(id);
  const other = root('run-not-verify');
  const bystander = spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
  children.push(bystander);
  const marketKid = member(other);
  const kid = member(vroot);
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(alive(kid));

  await failInterruptedRuns();

  assert.ok(await gone(kid), 'the check outlived the sweep');
  assert.ok(!existsSync(vroot), 'the verify run dir was not removed');
  // Outside the verify run roots nothing is touched.
  assert.ok(alive(bystander.pid as number), 'an unrelated process was killed');
  assert.ok(alive(marketKid), 'a process of another run root was killed');
  assert.ok(existsSync(join(other, 'repo', 'a.txt')), 'another run root was cleaned');
  assert.ok(existsSync(paths().runs));
});

test('a startup with no run roots is a no-op', async () => {
  await failInterruptedRuns();
});

test('a check is held to CHECK_MS, which the tool cap does not cut', () => {
  assert.ok(CHECK_MS <= MAX_TOOL_MS);
});
