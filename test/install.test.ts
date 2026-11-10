/**
 * The install stage (Task 14). PALIMPSEST_SANDBOX=off under a temp home
 * (test safety rule 7) and a fake spawner, so nothing is installed and no
 * registry is reached.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { realSpawner, setSpawner, type Spawned, type SpawnOpts } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { installDeps, needsReinstall, type RunContext } from '../engine/market/install.js';
import type { RunLogLine } from '../engine/market/provider.js';
import { repoMarketDefaults } from '../shared/market-rules.js';
import type { Repo, RepoChecks } from '../shared/types.js';

let tempDir: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['PALIMPSEST_HOME', 'PALIMPSEST_SANDBOX'];
let spawned: Array<{ cmd: string; args: string[]; opts: SpawnOpts }> = [];

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-install-test-'));
  process.env.PALIMPSEST_HOME = join(tempDir, 'home');
  process.env.PALIMPSEST_SANDBOX = 'off';
  spawned = [];
  setSpawner((cmd, args, opts): Spawned => {
    spawned.push({ cmd, args, opts });
    return {
      pid: null as unknown as number,
      lines: (async function* () {
        yield { stream: 'stdout' as const, line: 'added 3 packages' };
      })(),
      kill() {},
      done: Promise.resolve({ code: 0, signal: null }),
    };
  });
});

afterEach(() => {
  setSpawner(realSpawner);
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function checks(over: Partial<RepoChecks>): RepoChecks {
  return { test: null, typecheck: null, lint: null, build: null, screenshot: null, preview: null, shots: ['/'], install: null, ecosystems: [], detected: true, ...over };
}

function repo(c: RepoChecks | null): Repo {
  return {
    fullName: 'acme/widgets',
    private: false,
    defaultBranch: 'main',
    language: 'TypeScript',
    description: null,
    connected: true,
    pushMode: false,
    root: 'gothic',
    slot: 0,
    status: 'ready',
    error: null,
    connectedAt: null,
    analyzedAt: null,
    ...repoMarketDefaults(),
    checks: c,
  };
}

function context(stages: Array<{ stage: string; hosts: string[] }>, lines: RunLogLine[]): RunContext {
  const runRoot = join(paths().runs, 'run-install-1');
  const dir = join(runRoot, 'repo');
  mkdirSync(dir, { recursive: true });
  return {
    runId: 'run-install-1',
    runRoot,
    dir,
    log: (l) => lines.push(l),
    signal: new AbortController().signal,
    egress: { setStage: (stage, hosts) => stages.push({ stage, hosts }) },
  };
}

test('install runs with the install stage and the repo\'s ecosystems', async () => {
  const stages: Array<{ stage: string; hosts: string[] }> = [];
  const lines: RunLogLine[] = [];
  const ctx = context(stages, lines);
  const r = await installDeps(ctx, repo(checks({ install: 'npm ci && cargo fetch', ecosystems: ['npm', 'rust'] })));

  assert.equal(r.name, 'install');
  assert.equal(r.status, 'pass');
  assert.deepEqual(stages, [{ stage: 'install', hosts: ['registry.npmjs.org', 'index.crates.io', 'static.crates.io', 'crates.io'] }]);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, '/bin/sh');
  assert.deepEqual(spawned[0].args, ['-c', 'npm ci && cargo fetch']);
  assert.equal(spawned[0].opts.cwd, ctx.dir);
  assert.equal(spawned[0].opts.clearEnv, true);
  // Per-run caches: nothing reaches his shared npm or XDG caches.
  assert.equal(spawned[0].opts.env?.npm_config_cache, join(ctx.runRoot, 'cache', 'npm').replace(/^\/var\//, '/private/var/'));
  assert.ok(spawned[0].opts.env?.XDG_CACHE_HOME?.endsWith('/run-install-1/cache'));
  assert.equal(spawned[0].opts.maxMs, 10 * 60_000);
  const started = lines.find((l) => l.text === '$ npm ci && cargo fetch');
  assert.equal((started?.data as { stage?: string } | undefined)?.stage, 'install');
});

test('nothing to install is skipped', async () => {
  const stages: Array<{ stage: string; hosts: string[] }> = [];
  const ctx = context(stages, []);
  for (const c of [null, checks({})]) {
    const r = await installDeps(ctx, repo(c));
    assert.equal(r.status, 'skipped');
  }
  assert.equal(spawned.length, 0);
  assert.deepEqual(stages, []);
});

test('the install reruns before the after-checks only when the diff touches a manifest or a lockfile', () => {
  assert.equal(needsReinstall(['src/a.ts', 'README.md']), false);
  assert.equal(needsReinstall(['src/a.ts', 'package.json']), true);
  assert.equal(needsReinstall(['web/package-lock.json']), true);
  for (const f of ['pnpm-lock.yaml', 'yarn.lock', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'Cargo.lock', 'go.mod', 'go.sum']) {
    assert.equal(needsReinstall([f]), true, f);
  }
});
