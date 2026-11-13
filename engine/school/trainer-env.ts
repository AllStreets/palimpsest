/**
 * The trainer's environment (Phase 4 ruling 7, Decision 5): a native arm64
 * Python with `mlx` and `mlx-lm`. During development that is Beagle's venv,
 * named by PALIMPSEST_PYTHON (nothing downloaded); otherwise
 * `trainer/.venv`, which only `npm run trainer:setup` makes, run by him.
 * Nothing here installs anything: it finds the Python and asks the
 * trainer's own `school.py ping` what it is.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getRunner } from '../exec.js';

/** This repo's `trainer/` folder. */
export const TRAINER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'trainer');

/** How long a ping may take: reading package metadata, never starting the GPU. */
const PING_MS = 30_000;

/**
 * The trainer's Python: PALIMPSEST_PYTHON when set (and only if it exists:
 * a wrong override is never quietly replaced), else `trainer/.venv/bin/python`
 * when it exists, else null.
 */
export function trainerPython(trainerDir: string = TRAINER_DIR): string | null {
  const given = process.env.PALIMPSEST_PYTHON;
  if (given) return existsSync(given) ? given : null;
  const own = join(trainerDir, '.venv', 'bin', 'python');
  return existsSync(own) ? own : null;
}

export interface TrainerStatus {
  ready: boolean;
  reason: string | null;
  python: string | null;
  arch: string | null;
  mlx: string | null;
  mlxLm: string | null;
}

/**
 * The environment every trainer process gets: offline, no bytecode written
 * into a venv it borrows, no user site, and nothing of the engine's own
 * environment (no key or token can reach it).
 */
export function trainerEnv(): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin',
    LANG: 'en_US.UTF-8',
    HF_HUB_OFFLINE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
  };
}

const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);

/** Whether the trainer can run here, and if not, why, in words for Settings and the school screen. */
export async function trainerStatus(python: string | null = trainerPython()): Promise<TrainerStatus> {
  const none: TrainerStatus = { ready: false, reason: 'The trainer is not set up on this Mac', python: null, arch: null, mlx: null, mlxLm: null };
  if (!python) return none;
  const silent = (why: string): TrainerStatus => ({ ...none, python, reason: `The trainer's Python did not answer: ${why}` });
  let ping: Record<string, unknown>;
  try {
    const out = await getRunner()(python, [join(TRAINER_DIR, 'school.py'), 'ping'], { cwd: TRAINER_DIR, timeoutMs: PING_MS, env: trainerEnv() });
    if (out.code !== 0) return silent(`it exited ${out.code}`);
    const parsed = JSON.parse(out.stdout.trim().split('\n').at(-1) ?? '') as unknown;
    if (!parsed || typeof parsed !== 'object' || (parsed as { pong?: unknown }).pong !== true) return silent('no pong');
    ping = parsed as Record<string, unknown>;
  } catch (err) {
    return silent(err instanceof SyntaxError ? 'its answer was not JSON' : err instanceof Error ? err.message.slice(0, 200) : String(err));
  }
  const s: TrainerStatus = { ready: false, reason: null, python, arch: str(ping.arch), mlx: str(ping.mlx), mlxLm: str(ping.mlx_lm) };
  if (s.arch !== 'arm64') return { ...s, reason: "The trainer's Python is not arm64" };
  if (!s.mlx) return { ...s, reason: 'mlx is not installed in the trainer' };
  if (!s.mlxLm) return { ...s, reason: 'mlx-lm is not installed in the trainer' };
  return { ...s, ready: true };
}
