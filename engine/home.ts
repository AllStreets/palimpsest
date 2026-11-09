import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Paths {
  db: string;
  mirrors: string;
  usage: string;
  logs: string;
  stop: string;
  dist: string;
}

/** Where the data lives when PALIMPSEST_HOME is not set: ~/Library/Application Support/Palimpsest. */
export function defaultHome(): string {
  return join(homedir(), 'Library', 'Application Support', 'Palimpsest');
}

/** The data home. Honours PALIMPSEST_HOME, read fresh on every call. */
export function home(): string {
  // An empty value (PALIMPSEST_HOME="") means unset, never the current folder.
  return process.env.PALIMPSEST_HOME || defaultHome();
}

/**
 * Resolves every data path under the home, creating the directories that
 * hold files (mirrors, usage, logs). `db` and `stop` are file paths whose
 * parent (the home itself) is created, but the files are not. `dist` is
 * the built UI's output directory, resolved from this module's own location
 * (not the data home), overridable with PALIMPSEST_DIST.
 */
export function paths(): Paths {
  const base = home();
  const mirrors = join(base, 'mirrors');
  const usage = join(base, 'usage');
  const logs = join(base, 'logs');
  const db = join(base, 'palimpsest.db');
  const stop = join(base, 'STOP');

  for (const dir of [base, mirrors, usage, logs]) {
    mkdirSync(dir, { recursive: true });
  }

  const engineDir = dirname(fileURLToPath(import.meta.url));
  const dist = process.env.PALIMPSEST_DIST ?? join(engineDir, '..', 'dist');

  return { db, mirrors, usage, logs, stop, dist };
}
