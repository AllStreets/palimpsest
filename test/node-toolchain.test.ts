/**
 * The engine's own node is a toolchain wherever it lives (engine/market/sandbox.ts
 * detectToolchains): the file tools run it under the tool profile, so a node
 * outside the named toolchains (Volta, fnm, asdf, or a home other than the
 * one it was installed under, as in the Task 30 clean clone) must be read
 * and run there, or every file tool fails.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { detectToolchains, nodeRoot, toolProfile, wrap } from '../engine/market/sandbox.js';

test("the engine's node is a toolchain wherever it lives, never a folder above the home", () => {
  const t = realpathSync(mkdtempSync(join(tmpdir(), 'palimpsest-node-root-')));
  try {
    const home = join(t, 'home');
    mkdirSync(home, { recursive: true });
    // A Volta-style node outside every named toolchain: its install root is added.
    const volta = join(home, '.volta', 'tools', 'image', 'node', '22.13.0');
    mkdirSync(join(volta, 'bin'), { recursive: true });
    writeFileSync(join(volta, 'bin', 'node'), '');
    assert.equal(nodeRoot(join(volta, 'bin', 'node'), home), volta);
    assert.deepEqual(detectToolchains(home, join(volta, 'bin', 'node')), [volta]);
    // An nvm node under the detected ~/.nvm is that toolchain's already: not added twice.
    const nvm = join(home, '.nvm', 'versions', 'node', 'v22.13.0');
    mkdirSync(join(nvm, 'bin'), { recursive: true });
    writeFileSync(join(nvm, 'bin', 'node'), '');
    assert.deepEqual(detectToolchains(home, join(nvm, 'bin', 'node')), [join(home, '.nvm')]);
    // A node in a system path (Homebrew's, /usr/local's) is read there already.
    assert.equal(detectToolchains(home, '/usr/local/bin/node').includes('/usr/local'), false);
    // Never the home itself or a folder above it.
    mkdirSync(join(home, 'bin'), { recursive: true });
    assert.equal(nodeRoot(join(home, 'bin', 'node'), home), null);
    assert.equal(nodeRoot(join(t, 'bin', 'node'), home), null);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});

test("the engine's node runs under the tool profile on a home it was not installed under", { skip: process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') ? 'sandbox-exec is missing' : false }, () => {
  const t = realpathSync(mkdtempSync(join(tmpdir(), 'palimpsest-node-run-')));
  try {
    const home = join(t, 'home');
    const runRoot = join(home, 'data', 'runs', 'run-1');
    for (const d of ['repo', 'tmp', 'cache', 'ctl', 'ctmp']) mkdirSync(join(runRoot, d), { recursive: true });
    const argv = wrap([process.execPath, '-e', 'console.log("ran")'], 'tool', { runRoot, home, dataHome: join(home, 'data'), enginePort: 9, proxyPort: 9, toolchains: detectToolchains(home), otherPorts: [] });
    const r = spawnSync(argv[0], argv.slice(1), { cwd: join(runRoot, 'repo'), encoding: 'utf8', env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ran/);
    assert.ok(toolProfile({ runRoot, home, dataHome: join(home, 'data'), enginePort: 9, proxyPort: 9, toolchains: detectToolchains(home), otherPorts: [] }).length > 0);
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
});
