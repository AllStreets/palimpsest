/**
 * The trainer's environment (Phase 4 ruling 7, Decision 5): a native arm64
 * Python with `mlx` and `mlx-lm`. During development that is Beagle's venv,
 * named by PALIMPSEST_PYTHON (nothing downloaded); otherwise
 * `trainer/.venv`, which only `npm run trainer:setup` makes, run by him.
 * Nothing here installs anything: it finds the Python and asks the
 * trainer's own `school.py ping` what it is.
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getRunner } from '../exec.js';

/** This repo's `trainer/` folder. */
export const TRAINER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'trainer');

/** How long a ping may take: reading package metadata, never starting the GPU. */
const PING_MS = 30_000;

/** The versions `requirements.txt` pins; the status says whether the trainer has them, and never refuses for it. */
export const PINS = { mlx: '0.32.4', mlxLm: '0.32.2' } as const;

/** An absolute path to a regular file this process may execute. */
function runnable(path: string): boolean {
  if (!isAbsolute(path)) return false;
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** PALIMPSEST_PYTHON as given, and whether it is an absolute path to an executable file; null when unset. */
export function trainerOverride(): { given: string; ok: boolean } | null {
  const given = process.env.PALIMPSEST_PYTHON;
  if (!given) return null;
  return { given, ok: runnable(given) };
}

/** `trainer/.venv/bin/python`, which only `npm run trainer:setup` makes, when it is there. */
export function venvPython(trainerDir: string = TRAINER_DIR): string | null {
  const own = join(trainerDir, '.venv', 'bin', 'python');
  return existsSync(own) && runnable(own) ? own : null;
}

/**
 * The trainer's Python: PALIMPSEST_PYTHON when set, and only if it is an
 * absolute path to an executable file (a wrong override is never quietly
 * replaced by the venv), else the venv's Python, else null.
 */
export function trainerPython(trainerDir: string = TRAINER_DIR): string | null {
  const o = trainerOverride();
  if (o) return o.ok ? o.given : null;
  return venvPython(trainerDir);
}

export interface TrainerStatus {
  ready: boolean;
  reason: string | null;
  python: string | null;
  arch: string | null;
  mlx: string | null;
  mlxLm: string | null;
  /** Whether mlx and mlx-lm are the versions requirements.txt pins. */
  pinned: boolean;
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

/**
 * Whether the trainer can run here, and if not, why, in words for Settings
 * and the school screen. With no argument it finds the Python itself, and
 * says so when PALIMPSEST_PYTHON names something that is not one; with a
 * path it asks that Python; with null it is not set up.
 */
export async function trainerStatus(python?: string | null): Promise<TrainerStatus> {
  const none: TrainerStatus = { ready: false, reason: 'The trainer is not set up on this Mac', python: null, arch: null, mlx: null, mlxLm: null, pinned: false };
  if (python === undefined) {
    const o = trainerOverride();
    if (o && !o.ok) return { ...none, reason: 'PALIMPSEST_PYTHON does not point at a Python' };
    python = trainerPython();
  }
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
  const mlx = str(ping.mlx);
  const mlxLm = str(ping.mlx_lm);
  const s: TrainerStatus = { ready: false, reason: null, python, arch: str(ping.arch), mlx, mlxLm, pinned: mlx === PINS.mlx && mlxLm === PINS.mlxLm };
  if (s.arch !== 'arm64') return { ...s, reason: "The trainer's Python is not arm64" };
  if (!s.mlx) return { ...s, reason: 'mlx is not installed in the trainer' };
  if (!s.mlxLm) return { ...s, reason: 'mlx-lm is not installed in the trainer' };
  return { ...s, ready: true };
}
