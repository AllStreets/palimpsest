/**
 * The install stage (Task 14). PALIMPSEST_SANDBOX=off under a temp home
 * (test safety rule 7) and a fake spawner, so nothing is installed and no
 * registry is reached.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { realSpawner, setSpawner, type Spawned, type SpawnOpts } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { installDeps, needsReinstall, type RunContext } from '../engine/market/install.js';
import { cachePathOf, setTarballFetch } from '../engine/market/tarballs.js';
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
  setTarballFetch(null);
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

function lock(dir: string, resolved: string): void {
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' }, 'node_modules/beagle': { version: '0.1.0', resolved } } }),
  );
}

const SHA = 'd72c872ec704565da88e8cf792af1b06a23fd285';

test('a registry-only lockfile opens only the registry', async () => {
  const stages: Array<{ stage: string; hosts: string[] }> = [];
  const ctx = context(stages, []);
  lock(ctx.dir, 'https://registry.npmjs.org/beagle/-/beagle-0.1.0.tgz');
  const r = await installDeps(ctx, repo(checks({ install: 'npm ci', ecosystems: ['npm'] })));
  assert.equal(r.status, 'pass');
  assert.deepEqual(stages, [{ stage: 'install', hosts: ['registry.npmjs.org'] }]);
});

test('a codeload tarball in the lockfile also opens codeload.github.com, and nothing else', async () => {
  const stages: Array<{ stage: string; hosts: string[] }> = [];
  const ctx = context(stages, []);
  lock(ctx.dir, `https://codeload.github.com/AllStreets/beagle/tar.gz/${SHA}`);
  const r = await installDeps(ctx, repo(checks({ install: 'npm ci', ecosystems: ['npm'] })));
  assert.equal(r.status, 'pass');
  assert.deepEqual(stages, [{ stage: 'install', hosts: ['registry.npmjs.org', 'codeload.github.com'] }]);
});

test('a git+ssh dependency fails the install with a reason naming it, before anything runs', async () => {
  const stages: Array<{ stage: string; hosts: string[] }> = [];
  const lines: RunLogLine[] = [];
  const ctx = context(stages, lines);
  lock(ctx.dir, `git+ssh://git@github.com/AllStreets/beagle.git#${SHA}`);
  const r = await installDeps(ctx, repo(checks({ install: 'npm ci', ecosystems: ['npm'] })));
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /beagle/);
  assert.match(r.detail, /package-lock\.json/);
  assert.match(r.detail, /SSH/);
  assert.match(r.detail, /git\+ssh:\/\/git@github\.com\/AllStreets\/beagle\.git/);
  assert.equal(spawned.length, 0, 'npm never runs');
  assert.ok(lines.some((l) => /beagle/.test(l.text)), 'the run log says why');
});

test('a host the proxy refuses stops the install at once, naming the host, instead of waiting for its limit', async () => {
  const lines: RunLogLine[] = [];
  const listeners: Array<(host: string) => void> = [];
  const killed: string[] = [];
  let release: () => void = () => {};
  const ended = new Promise<void>((r) => (release = r));
  // npm retrying a refused CONNECT forever: the command never ends on its own.
  setSpawner((cmd, args, opts): Spawned => {
    spawned.push({ cmd, args, opts });
    return {
      pid: null as unknown as number,
      lines: (async function* () {
        yield { stream: 'stderr' as const, line: 'npm http fetch GET https://objects.example.net/ffmpeg.zip attempt 1 failed with 403' };
        await ended;
      })(),
      kill(sig?: NodeJS.Signals | number) {
        killed.push(String(sig));
        release();
      },
      done: ended.then(() => ({ code: null, signal: 'SIGKILL' as NodeJS.Signals })),
    };
  });
  const ctx: RunContext = {
    ...context([], lines),
    egress: {
      setStage() {},
      onRefused(fn: (host: string) => void) {
        listeners.push(fn);
        return () => listeners.splice(listeners.indexOf(fn), 1);
      },
    },
  };
  const started = Date.now();
  const pending = installDeps(ctx, repo(checks({ install: 'npm ci', ecosystems: ['npm'] })));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(listeners.length, 1, 'the install listens for refusals while it runs');
  listeners[0]('objects.example.net');
  const r = await pending;
  assert.ok(Date.now() - started < 5_000, 'it ends at once, not at its 10 minute limit');
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /objects\.example\.net/);
  assert.match(r.detail, /registry\.npmjs\.org/, 'it names what the install may reach');
  assert.doesNotMatch(r.detail, /timed out|run is ending/);
  assert.ok(killed.includes('SIGKILL'), 'the command was stopped');
  assert.equal(listeners.length, 0, 'it stops listening once the install is over');
  assert.ok(lines.some((l) => /objects\.example\.net/.test(l.text) && l.kind === 'engine'), 'the run log says why');
});

test('a GitHub tarball the lockfile pins is in the run\'s npm cache before npm runs, so the install never streams it', async () => {
  const bytes = Buffer.from('beagle at its pin');
  const hex = createHash('sha512').update(bytes).digest('hex');
  const fetched: string[] = [];
  setTarballFetch(async (url) => {
    fetched.push(url);
    return new Response(bytes);
  });
  const ctx = context([], []);
  writeFileSync(
    join(ctx.dir, 'package-lock.json'),
    JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' }, 'node_modules/beagle': { version: '0.1.0', resolved: `https://codeload.github.com/AllStreets/beagle/tar.gz/${SHA}`, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` } } }),
  );
  let seenAtSpawn = false;
  setSpawner((cmd, args, opts): Spawned => {
    spawned.push({ cmd, args, opts });
    seenAtSpawn = existsSync(cachePathOf(opts.env?.npm_config_cache ?? '', hex));
    return { pid: null as unknown as number, lines: (async function* () {})(), kill() {}, done: Promise.resolve({ code: 0, signal: null }) };
  });
  const r = await installDeps(ctx, repo(checks({ install: 'npm ci', ecosystems: ['npm'] })));
  assert.equal(r.status, 'pass');
  assert.deepEqual(fetched, [`https://codeload.github.com/AllStreets/beagle/tar.gz/${SHA}`]);
  assert.ok(seenAtSpawn, 'npm finds the tarball by its integrity in its own cache');
});

test('a pinned tarball the engine cannot fetch fails the install with its name, before npm runs', async () => {
  setTarballFetch(async () => new Response('gone', { status: 404 }));
  const lines: RunLogLine[] = [];
  const ctx = context([], lines);
  writeFileSync(
    join(ctx.dir, 'package-lock.json'),
    JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' }, 'node_modules/beagle': { version: '0.1.0', resolved: `https://codeload.github.com/AllStreets/beagle/tar.gz/${SHA}`, integrity: `sha512-${'A'.repeat(86)}==` } } }),
  );
  const r = await installDeps(ctx, repo(checks({ install: 'npm ci', ecosystems: ['npm'] })));
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /beagle/);
  assert.match(r.detail, /404/);
  assert.equal(spawned.length, 0, 'npm never runs');
  assert.ok(lines.some((l) => /beagle/.test(l.text) && l.kind === 'engine'));
});

test('an install stopped at its time limit is a plain fail that says so, which the runner counts as the engine\'s', async () => {
  setSpawner((cmd, args, opts): Spawned => {
    spawned.push({ cmd, args, opts });
    return { pid: null as unknown as number, lines: (async function* () {})(), kill() {}, done: Promise.resolve({ code: null, signal: 'SIGKILL', timedOut: true }) };
  });
  const r = await installDeps(context([], []), repo(checks({ install: 'npm ci', ecosystems: ['npm'] })));
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /^npm ci exited without a code: \[palimpsest\] timed out after 600000 ms/);
});
