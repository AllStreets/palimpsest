/**
 * `npm run test:trainer`: the trainer's own Python tests (trainer/test_school.py),
 * never part of `npm test`. Runs on the trainer's Python (PALIMPSEST_PYTHON or
 * trainer/.venv), offline, writing no bytecode; skips with a message when there
 * is none. It installs nothing.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TRAINER_DIR, trainerEnv, trainerOverride, trainerPython } from '../engine/school/trainer-env.js';

// a PALIMPSEST_PYTHON that names no Python is a mistake to fix, not a reason to skip
if (trainerOverride()?.ok === false) {
  console.error('PALIMPSEST_PYTHON does not point at a Python');
  process.exit(1);
}
const python = trainerPython();
if (!python) {
  console.log('Skipped: no trainer Python');
  process.exit(0);
}
// a throwaway HOME, so nothing the tests start reads or writes his own
const home = mkdtempSync(join(tmpdir(), 'palimpsest-trainer-test-'));
const r = spawnSync(python, ['-m', 'unittest', '-v', 'test_school'], { cwd: TRAINER_DIR, stdio: 'inherit', env: { ...trainerEnv(), HOME: home, TMPDIR: home } });
rmSync(home, { recursive: true, force: true });
process.exit(r.status ?? 1);
