/**
 * Check detection and test count parsing (Task 14). Every fixture is a temp
 * directory with a manifest or a lockfile; nothing is installed or run.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { realRunner, setRunner } from '../engine/exec.js';
import { detectChecks, detectChecksInMirror, parseTestsRun } from '../engine/guild/checks.js';
import { sampleGh } from '../engine/sample.js';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-checks-test-'));
});

afterEach(() => {
  setRunner(realRunner);
  rmSync(tempDir, { recursive: true, force: true });
});

function fixture(name: string, files: Record<string, string>): string {
  const dir = join(tempDir, name);
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return dir;
}

test('detects npm, cargo, pytest and go checks from fixtures', () => {
  const npm = detectChecks(fixture('npm', {
    'package.json': JSON.stringify({
      scripts: { test: 'node --test', lint: 'eslint .', build: 'vite build', 'palimpsest:screenshot': 'node shot.mjs' },
      devDependencies: { typescript: '^5.0.0' },
    }),
    'tsconfig.json': '{}',
    'package-lock.json': '{}',
  }));
  assert.equal(npm.test, 'npm test');
  assert.equal(npm.typecheck, './node_modules/.bin/tsc --noEmit');
  assert.equal(npm.lint, 'npm run lint');
  assert.equal(npm.build, 'npm run build');
  assert.equal(npm.screenshot, 'npm run palimpsest:screenshot');
  assert.equal(npm.install, 'npm ci');
  assert.deepEqual(npm.ecosystems, ['npm']);
  assert.equal(npm.detected, true);

  const typed = detectChecks(fixture('typed', { 'package.json': JSON.stringify({ scripts: { typecheck: 'tsc -p .' } }) }));
  assert.equal(typed.typecheck, 'npm run typecheck');
  // npm's placeholder test script is no test at all.
  const placeholder = detectChecks(fixture('placeholder', { 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }));
  assert.equal(placeholder.test, null);

  const cargo = detectChecks(fixture('cargo', { 'Cargo.toml': '[package]\nname = "q"\n', 'Cargo.lock': '' }));
  assert.equal(cargo.test, 'cargo test');
  assert.equal(cargo.build, 'cargo build');
  assert.equal(cargo.install, 'cargo fetch');
  assert.deepEqual(cargo.ecosystems, ['rust']);

  const pytest = detectChecks(fixture('pytest', { 'pytest.ini': '[pytest]\n' }));
  assert.equal(pytest.test, 'pytest');
  assert.equal(pytest.build, null);
  assert.equal(pytest.install, null);

  const go = detectChecks(fixture('go', { 'go.mod': 'module x\n', 'go.sum': '' }));
  assert.equal(go.test, 'go test ./...');
  assert.equal(go.build, 'go build ./...');
  assert.equal(go.install, 'go mod download');
  assert.deepEqual(go.ecosystems, ['go']);

  const make = detectChecks(fixture('make', { Makefile: 'all: build\n\ntest:\n\t./run-tests\n\nbuild:\n\tcc -o x x.c\n' }));
  assert.equal(make.test, 'make test');
  assert.equal(make.build, 'make build');
});

test('detects a vite preview and a static index', () => {
  const vite = detectChecks(fixture('vite', {
    'package.json': JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { vite: '^8.0.0' } }),
    'index.html': '<!doctype html>',
  }));
  assert.deepEqual(vite.preview, { kind: 'vite', outDir: 'dist' });
  assert.deepEqual(vite.shots, ['/']);

  const nextExport = detectChecks(fixture('next', {
    'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }),
    'next.config.mjs': "export default { output: 'export' };\n",
  }));
  assert.deepEqual(nextExport.preview, { kind: 'next', outDir: 'out' });
  const nextServer = detectChecks(fixture('next-server', {
    'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }),
    'next.config.js': 'module.exports = {};\n',
  }));
  assert.equal(nextServer.preview, null);

  const astro = detectChecks(fixture('astro', { 'package.json': JSON.stringify({ dependencies: { astro: '5.0.0' } }) }));
  assert.deepEqual(astro.preview, { kind: 'astro', outDir: 'dist' });

  const plain = detectChecks(fixture('static', { 'index.html': '<!doctype html><title>x</title>' }));
  assert.deepEqual(plain.preview, { kind: 'static', outDir: '.' });
});

test('no manifest gives null checks and detected true', () => {
  const c = detectChecks(fixture('empty', { 'README.md': '# nothing\n' }));
  assert.deepEqual(c, {
    test: null,
    typecheck: null,
    lint: null,
    build: null,
    screenshot: null,
    preview: null,
    shots: ['/'],
    install: null,
    ecosystems: [],
    detected: true,
  });
});

test('install commands follow the lockfile', () => {
  const pkg = JSON.stringify({ scripts: { test: 'vitest run', build: 'tsc' } });
  const npm = detectChecks(fixture('l-npm', { 'package.json': pkg, 'package-lock.json': '{}' }));
  assert.equal(npm.install, 'npm ci');
  const pnpm = detectChecks(fixture('l-pnpm', { 'package.json': pkg, 'pnpm-lock.yaml': '' }));
  assert.equal(pnpm.install, 'pnpm install --frozen-lockfile');
  assert.equal(pnpm.test, 'pnpm test');
  assert.equal(pnpm.build, 'pnpm run build');
  const yarn = detectChecks(fixture('l-yarn', { 'package.json': pkg, 'yarn.lock': '' }));
  assert.equal(yarn.install, 'yarn install --immutable');
  assert.equal(yarn.test, 'yarn test');
  assert.deepEqual(yarn.ecosystems, ['npm']);

  const req = detectChecks(fixture('l-req', { 'requirements.txt': 'pytest\n', 'pytest.ini': '' }));
  assert.equal(req.install, 'python3 -m venv .venv && .venv/bin/pip install -r requirements.txt');
  assert.deepEqual(req.ecosystems, ['python']);
  const pyproject = detectChecks(fixture('l-pyproject', { 'pyproject.toml': '[project]\nname = "a"\n' }));
  assert.equal(pyproject.install, 'python3 -m venv .venv && .venv/bin/pip install -e .');
  assert.equal(pyproject.test, '.venv/bin/python -m pytest');

  const cargo = detectChecks(fixture('l-cargo', { 'Cargo.toml': '', 'Cargo.lock': '' }));
  assert.equal(cargo.install, 'cargo fetch');
  const go = detectChecks(fixture('l-go', { 'go.mod': '', 'go.sum': '' }));
  assert.equal(go.install, 'go mod download');

  // Two ecosystems install one after the other.
  const both = detectChecks(fixture('l-both', { 'package.json': pkg, 'package-lock.json': '{}', 'go.mod': '', 'go.sum': '' }));
  assert.equal(both.install, 'npm ci && go mod download');
  assert.deepEqual(both.ecosystems, ['npm', 'go']);

  // A manifest without a lockfile installs nothing.
  const bare = detectChecks(fixture('l-bare', { 'package.json': pkg }));
  assert.equal(bare.install, null);
  assert.deepEqual(bare.ecosystems, []);
});

test('test counts parse from node --test output', () => {
  const tap = ['TAP version 13', '# Subtest: a', 'ok 1 - a', '1..3', '# tests 3', '# suites 0', '# pass 2', '# fail 1'].join('\n');
  assert.equal(parseTestsRun(tap), 3);
  const spec = ['✔ a (1.2ms)', '✔ b (0.4ms)', 'ℹ tests 2', 'ℹ suites 0', 'ℹ pass 2', 'ℹ fail 0'].join('\n');
  assert.equal(parseTestsRun(spec), 2);

  assert.equal(parseTestsRun(' Test Files  2 passed (2)\n      Tests  1 failed | 11 passed (12)\n'), 12);
  assert.equal(parseTestsRun('Tests:       1 failed, 11 passed, 12 total\nSnapshots:   0 total\n'), 12);
  assert.equal(parseTestsRun('=================== 5 passed, 2 failed, 1 skipped in 0.31s ===================\n'), 7);
  assert.equal(
    parseTestsRun('test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured\n\ntest result: ok. 2 passed; 1 failed; 0 ignored\n'),
    7,
  );
  assert.equal(parseTestsRun('=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n--- FAIL: TestB (0.00s)\n    --- PASS: TestB/sub (0.00s)\nFAIL\n'), 2);
  assert.equal(parseTestsRun('ok  \texample.com/x\t0.01s\n'), null);
  assert.equal(parseTestsRun('\x1b[32m# tests 4\x1b[39m\n'), 4);
});

test('the sample stand-in answers detection for the sample repos', async () => {
  setRunner(sampleGh());
  const mirror = (full: string) => join(tempDir, 'mirrors', `${full.replace('/', '__')}.git`);
  const harbor = await detectChecksInMirror(mirror('tidewater/harbor-ledger'), 'main');
  assert.equal(harbor.test, 'npm test');
  assert.equal(harbor.typecheck, 'npm run typecheck');
  assert.equal(harbor.build, 'npm run build');
  assert.deepEqual(harbor.preview, { kind: 'vite', outDir: 'dist' });
  const swift = await detectChecksInMirror(mirror('kestrel/fieldnotes'), 'main');
  assert.equal(swift.test, null);
  assert.equal(swift.build, null);
  const python = await detectChecksInMirror(mirror('lantern/assay-kit'), 'main');
  assert.equal(python.test, '.venv/bin/python -m pytest');
  assert.equal(python.build, null);
  assert.deepEqual((await detectChecksInMirror(mirror('ferro/quarry'), 'main')).ecosystems, ['rust']);
  assert.equal((await detectChecksInMirror(mirror('hoshi/kumo'), 'main')).build, 'go build ./...');
  assert.equal((await detectChecksInMirror(mirror('alder/blank-slate'), 'main')).detected, true);
});
