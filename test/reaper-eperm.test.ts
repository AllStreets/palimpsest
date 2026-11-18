import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { reapGroup, setReaperRunner } from '../engine/market/reaper.js';

afterEach(() => setReaperRunner(null));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('reapGroup falls back to the process group when ps fails with EPERM', async () => {
  setReaperRunner(async (cmd) => {
    const err = Object.assign(new Error(`spawn ${cmd} EPERM`), { code: 'EPERM' });
    throw err;
  });
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  const exited = new Promise((r) => child.once('exit', r));
  const pid = child.pid!;
  assert.ok(alive(pid));
  const root = mkdtempSync(join(tmpdir(), 'reaper-eperm-'));
  await assert.doesNotReject(reapGroup(root, pid));
  await exited;
  assert.equal(alive(pid), false, 'the group was killed without ps');
});
