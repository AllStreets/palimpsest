/**
 * The sample city in one command (Phase 5 ruling 13):
 *
 *   npm run sample
 *
 * seeds the sample city, its economy and its school into a sample folder and
 * serves it on 127.0.0.1:4790 with the board moving, until Ctrl+C. The folder
 * is PALIMPSEST_SAMPLE_HOME, or `sample-home/` in the folder it is run from
 * (the repo, gitignored). It refuses his real Palimpsest folder, however it is
 * spelled, and any folder that has files in it and no sample marker (test
 * safety rule 20); a folder that already holds a sample is emptied and seeded
 * again. The city is seeded at SEED_AT, the hour every README still is shot
 * at, unless SAMPLE_NOW=1 seeds it at the present.
 *
 * Nothing here reaches GitHub, Claude, Ollama, the network or his folders: the
 * home is a sample's from its first file on (seedSample writes the marker
 * first), so the engine answers every gh and git call from the sample
 * stand-in, runs every model on the scripted fake provider and reads only the
 * sample's own transcripts, Codex and Gemini folders. It never binds 4770.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { canonical, isRealDataHome } from '../engine/home.js';
import { isSampleHome } from '../engine/sample.js';

/** The sample's own port: never the engine's 4770 or the dev server's 4771. */
export const SAMPLE_PORT = 4790;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const REAL = 'That is your real Palimpsest folder; the sample needs its own.';
const NOT_SAMPLE = 'That folder has files in it and is not a sample; choose an empty one.';

/** His real data folder as `env` places his home (HOME), else as the OS does. */
function realHomeFor(env: NodeJS.ProcessEnv): string {
  return join(env.HOME || homedir(), 'Library', 'Application Support', 'Palimpsest');
}

/** True when `dir` is `root` or inside it, however either is spelled. */
function within(dir: string, root: string): boolean {
  const rel = relative(canonical(root), canonical(dir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Where `npm run sample` may write: PALIMPSEST_SAMPLE_HOME (resolved against
 * `cwd`) or `<cwd>/sample-home`. Refuses his real Palimpsest folder or any
 * folder inside it, and anything that exists, is not an empty folder and has
 * no sample marker. Only names and folder listings are read; nothing is
 * opened or written.
 */
export function sampleTarget(env: NodeJS.ProcessEnv, cwd: string): { dir: string } | { refuse: string } {
  const dir = resolve(cwd, env.PALIMPSEST_SAMPLE_HOME || 'sample-home');
  const real = realHomeFor(env);
  if (isRealDataHome(dir, real) || within(dir, real)) return { refuse: REAL };
  if (!existsSync(dir)) return { dir };
  if (!statSync(dir).isDirectory()) return { refuse: NOT_SAMPLE };
  if (readdirSync(dir).length === 0 || isSampleHome(dir)) return { dir };
  return { refuse: NOT_SAMPLE };
}

/** Builds the UI into dist/ when no build is there, quietly; its output is shown only if it fails. */
function ensureBuilt(): void {
  if (existsSync(join(ROOT, 'dist', 'index.html'))) return;
  const vite = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const r = spawnSync(process.execPath, [vite, 'build'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(`${r.stdout ?? ''}${r.stderr ?? ''}`);
    throw new Error('the UI did not build');
  }
}

/** Runs `fn` with console.log and console.info silenced, so the run prints its one line and nothing else. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const { log, info } = console;
  console.log = () => {};
  console.info = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.info = info;
  }
}

async function main(): Promise<void> {
  const target = sampleTarget(process.env, process.cwd());
  if ('refuse' in target) {
    console.error(target.refuse);
    process.exit(2);
  }
  const { dir } = target;
  // A folder that holds a sample is seeded again from nothing, so every run opens on the same city.
  if (existsSync(dir) && isSampleHome(dir)) {
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
  process.env.PALIMPSEST_HOME = dir;
  process.env.PALIMPSEST_SAMPLE_ECONOMY = 'live';
  // Every reader of his folders is pointed at the sample's own, never at a value this shell happened to carry.
  for (const k of ['PALIMPSEST_CLAUDE_PROJECTS', 'PALIMPSEST_TEST_PROJECTS', 'PALIMPSEST_CODEX_HOME', 'PALIMPSEST_GEMINI_HOME', 'PALIMPSEST_CLAUDE_SETTINGS', 'PALIMPSEST_DIST', 'PALIMPSEST_PORT']) delete process.env[k];

  const { SEED_AT, seedSample } = await import('./sample.js');
  const at = process.env.SAMPLE_NOW === '1' ? Date.now() : SEED_AT;
  const server = await quietly(async () => {
    ensureBuilt();
    await seedSample(at);
    const { seedEconomy } = await import('../engine/market/sample-economy.js');
    await seedEconomy(at);
    const { bootSampleEngine } = await import('../engine/sample-boot.js');
    await bootSampleEngine();
    const { startServer } = await import('../engine/server.js');
    return startServer({ port: SAMPLE_PORT });
  });
  console.log(`The sample city is at http://127.0.0.1:${SAMPLE_PORT}`);
  const stop = () => {
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
