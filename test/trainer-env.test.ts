/**
 * The trainer's environment (Phase 4 Task 5). No test runs the real Python
 * (test safety rule 11): the probe goes through a fake runner, and the
 * paths are temp files.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { realRunner, setRunner, type Runner } from '../engine/exec.js';
import { TRAINER_DIR, trainerPython, trainerStatus } from '../engine/school/trainer-env.js';

let tempDir: string;
let previous: string | undefined;

beforeEach(() => {
  previous = process.env.PALIMPSEST_PYTHON;
  delete process.env.PALIMPSEST_PYTHON;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-trainer-env-'));
});

afterEach(() => {
  setRunner(realRunner);
  if (previous === undefined) delete process.env.PALIMPSEST_PYTHON;
  else process.env.PALIMPSEST_PYTHON = previous;
  rmSync(tempDir, { recursive: true, force: true });
});

/** A file standing in for a python binary; never run. */
function fakePython(path = join(tempDir, 'bin', 'python')): string {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\nexit 99\n');
  chmodSync(path, 0o755);
  return path;
}

/** A runner that answers the trainer's ping as a python of `arch` with these packages would, and records the call. */
function pingAs(answer: Record<string, unknown> | string, code = 0): { calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> } {
  const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
  const r: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, env: opts?.env });
    return { stdout: typeof answer === 'string' ? answer : JSON.stringify(answer) + '\n', stderr: '', code };
  };
  setRunner(r);
  return { calls };
}

test('trainerPython is PALIMPSEST_PYTHON when it exists, else the trainer venv when it exists, else null', () => {
  const venv = join(tempDir, 'trainer');
  assert.equal(trainerPython(venv), null, 'nothing set up');
  const own = fakePython(join(venv, '.venv', 'bin', 'python'));
  assert.equal(trainerPython(venv), own);
  const given = fakePython();
  process.env.PALIMPSEST_PYTHON = given;
  assert.equal(trainerPython(venv), given, 'the override wins');
  process.env.PALIMPSEST_PYTHON = join(tempDir, 'missing', 'python');
  assert.equal(trainerPython(venv), null, 'an override that does not exist is not quietly replaced');
  assert.match(TRAINER_DIR, /trainer$/);
});

test('trainerStatus is not ready without a python and says so', async () => {
  const { calls } = pingAs({ pong: true });
  const s = await trainerStatus(null);
  assert.deepEqual(s, { ready: false, reason: 'The trainer is not set up on this Mac', python: null, arch: null, mlx: null, mlxLm: null });
  assert.equal(calls.length, 0, 'nothing is run');
});

test('it refuses x86_64', async () => {
  const python = fakePython();
  pingAs({ pong: true, python: '3.12.7', arch: 'x86_64', mlx: null, mlx_lm: null });
  const s = await trainerStatus(python);
  assert.equal(s.ready, false);
  assert.equal(s.reason, "The trainer's Python is not arm64");
  assert.equal(s.arch, 'x86_64');
});

test('it is ready for arm64 with mlx 0.32.4 and mlx_lm 0.32.2', async () => {
  const python = fakePython();
  const { calls } = pingAs({ pong: true, python: '3.12.7', arch: 'arm64', mlx: '0.32.4', mlx_lm: '0.32.2' });
  const s = await trainerStatus(python);
  assert.deepEqual(s, { ready: true, reason: null, python, arch: 'arm64', mlx: '0.32.4', mlxLm: '0.32.2' });
  // the ping runs the trainer's own script, offline and writing no bytecode, with no key in its environment
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, python);
  assert.deepEqual(calls[0].args, [join(TRAINER_DIR, 'school.py'), 'ping']);
  const env = calls[0].env ?? {};
  assert.equal(env.HF_HUB_OFFLINE, '1');
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(env.PYTHONNOUSERSITE, '1');
  for (const k of Object.keys(env)) assert.doesNotMatch(k, /KEY|TOKEN|SECRET/i, k);
});

test('without mlx or mlx-lm it is not ready and names what is missing', async () => {
  const python = fakePython();
  pingAs({ pong: true, python: '3.12.7', arch: 'arm64', mlx: null, mlx_lm: '0.32.2' });
  assert.equal((await trainerStatus(python)).reason, 'mlx is not installed in the trainer');
  pingAs({ pong: true, python: '3.12.7', arch: 'arm64', mlx: '0.32.4', mlx_lm: null });
  assert.equal((await trainerStatus(python)).reason, 'mlx-lm is not installed in the trainer');
});

test('a ping that fails or answers nonsense is not ready, with the reason', async () => {
  const python = fakePython();
  pingAs('Traceback: boom', 1);
  const failed = await trainerStatus(python);
  assert.equal(failed.ready, false);
  assert.match(failed.reason ?? '', /did not answer/);
  pingAs('not json');
  assert.match((await trainerStatus(python)).reason ?? '', /did not answer/);
  setRunner(async () => {
    throw new Error('spawn ENOENT');
  });
  assert.match((await trainerStatus(python)).reason ?? '', /did not answer/);
});
