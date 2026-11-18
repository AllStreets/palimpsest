/**
 * GitHub tarballs a lockfile pins are fetched by the engine, once, checked
 * against the lock's integrity and cloned into each run's npm cache, so a
 * run's install never streams them itself. A temp home and a fake fetch:
 * nothing reaches GitHub.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import type { RunLogLine } from '../engine/market/provider.js';
import { cachePathOf, pinnedTarballs, seedTarballs, setTarballFetch, tarballStore } from '../engine/market/tarballs.js';

let tempDir: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.PALIMPSEST_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-tarballs-test-'));
  process.env.PALIMPSEST_HOME = join(tempDir, 'home');
});

afterEach(() => {
  setTarballFetch(null);
  if (saved === undefined) delete process.env.PALIMPSEST_HOME;
  else process.env.PALIMPSEST_HOME = saved;
  rmSync(tempDir, { recursive: true, force: true });
});

const SHA = 'd72c872ec704565da88e8cf792af1b06a23fd285';
const URL_ = `https://codeload.github.com/AllStreets/beagle/tar.gz/${SHA}`;
const BYTES = Buffer.from('a tarball, pretend it is 284 MB of Beagle');

function integrityOf(b: Buffer): string {
  return `sha512-${createHash('sha512').update(b).digest('base64')}`;
}

function hexOf(b: Buffer): string {
  return createHash('sha512').update(b).digest('hex');
}

function repoWith(packages: Record<string, Record<string, unknown>>): string {
  const dir = join(tempDir, `repo-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' }, ...packages } }));
  return dir;
}

function beagleRepo(integrity = integrityOf(BYTES)): string {
  return repoWith({ 'node_modules/beagle': { version: '0.1.0', resolved: URL_, integrity } });
}

function fakeFetch(answers: Array<() => Response | Promise<Response>>) {
  const calls: string[] = [];
  setTarballFetch(async (url) => {
    calls.push(url);
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    return next();
  });
  return calls;
}

function seed(dir: string, cacheDir: string, lines: RunLogLine[] = []) {
  return seedTarballs({ dir, cacheDir, signal: new AbortController().signal, log: (l) => lines.push(l) });
}

test('only GitHub tarballs pinned with a sha512 integrity are the engine\'s to fetch', () => {
  const dir = repoWith({
    'node_modules/beagle': { version: '0.1.0', resolved: URL_, integrity: integrityOf(BYTES) },
    'node_modules/arch': { version: '1.0.0', resolved: `https://github.com/a/arch/archive/${SHA}.tar.gz`, integrity: integrityOf(Buffer.from('arch')) },
    'node_modules/three': { version: '0.187.0', resolved: 'https://registry.npmjs.org/three/-/three-0.187.0.tgz', integrity: integrityOf(Buffer.from('three')) },
    'node_modules/loose': { version: '1.0.0', resolved: `https://codeload.github.com/a/loose/tar.gz/${SHA}` },
    'node_modules/sha1': { version: '1.0.0', resolved: `https://codeload.github.com/a/sha1/tar.gz/${SHA}`, integrity: 'sha1-AAAA' },
    'node_modules/clone': { version: '1.0.0', resolved: `git+https://github.com/a/clone.git#${SHA}`, integrity: integrityOf(Buffer.from('clone')) },
    'node_modules/elsewhere': { version: '1.0.0', resolved: 'https://example.com/elsewhere.tgz', integrity: integrityOf(Buffer.from('e')) },
  });
  const found = pinnedTarballs(dir);
  assert.deepEqual(
    found.map((t) => [t.name, t.url]),
    [
      ['beagle', URL_],
      ['arch', `https://github.com/a/arch/archive/${SHA}.tar.gz`],
    ],
  );
  assert.equal(found[0].hex, hexOf(BYTES));
  assert.deepEqual(pinnedTarballs(join(tempDir, 'no-such-repo')), []);
});

test('a pinned tarball is fetched once, checked, kept, and cloned into every run\'s npm cache where npm looks for it', async () => {
  const calls = fakeFetch([() => new Response(BYTES)]);
  const lines: RunLogLine[] = [];
  const cacheA = join(tempDir, 'run-a', 'cache', 'npm');
  const first = await seed(beagleRepo(), cacheA, lines);
  assert.equal(first.failed, null);
  assert.deepEqual(calls, [URL_]);
  const path = cachePathOf(cacheA, hexOf(BYTES));
  assert.equal(path, join(cacheA, '_cacache', 'content-v2', 'sha512', hexOf(BYTES).slice(0, 2), hexOf(BYTES).slice(2, 4), hexOf(BYTES).slice(4)));
  assert.deepEqual(readFileSync(path), BYTES);
  assert.ok(existsSync(join(tarballStore(), `${hexOf(BYTES)}.tgz`)), 'kept for the next run');
  assert.ok(lines.some((l) => /beagle/.test(l.text) && /codeload\.github\.com/.test(l.text)), 'the run log says where it came from');

  // The next run, even of another repo pinning the same tarball, gets it from the store: GitHub is not asked again.
  const cacheB = join(tempDir, 'run-b', 'cache', 'npm');
  const second = await seed(beagleRepo(), cacheB);
  assert.equal(second.failed, null);
  assert.deepEqual(calls, [URL_]);
  assert.deepEqual(readFileSync(cachePathOf(cacheB, hexOf(BYTES))), BYTES);
  // A run writing to its copy never reaches the store's.
  writeFileSync(cachePathOf(cacheB, hexOf(BYTES)), 'scribbled');
  assert.deepEqual(readFileSync(join(tarballStore(), `${hexOf(BYTES)}.tgz`)), BYTES);
});

test('bytes that do not match the lock\'s integrity are never kept or handed to a run', async () => {
  fakeFetch([() => new Response('not beagle'), () => new Response('still not beagle')]);
  const cache = join(tempDir, 'run-a', 'cache', 'npm');
  const r = await seed(beagleRepo(), cache);
  assert.match(r.failed ?? '', /beagle/);
  assert.match(r.failed ?? '', /codeload\.github\.com/);
  assert.match(r.failed ?? '', /integrity/);
  assert.equal(existsSync(cachePathOf(cache, hexOf(BYTES))), false);
  assert.deepEqual(existsSync(tarballStore()) ? readdirSync(tarballStore()) : [], []);
});

test('a download that stalls is given up on fast, tried once more, then named', async () => {
  setTarballFetch(null, { stallMs: 50, attemptMs: 5_000, attempts: 2 });
  const calls = fakeFetch([
    () => new Response(new ReadableStream({ start: (c) => c.enqueue(new Uint8Array([1, 2, 3])) })),
    () => new Response(new ReadableStream({ start: (c) => c.enqueue(new Uint8Array([1, 2, 3])) })),
  ]);
  const started = Date.now();
  const r = await seed(beagleRepo(), join(tempDir, 'run-a', 'cache', 'npm'));
  assert.ok(Date.now() - started < 3_000, 'never waits for the install\'s limit');
  assert.equal(calls.length, 2, 'a stalled connection is dropped and the tarball asked for again');
  assert.match(r.failed ?? '', /beagle/);
  assert.match(r.failed ?? '', /sent nothing for/);
});

test('a download that trickles is given up on at its time limit, and a fresh one that runs well is kept', async () => {
  setTarballFetch(null, { stallMs: 1_000, attemptMs: 120, attempts: 2 });
  let tick: ReturnType<typeof setInterval> | undefined;
  const calls = fakeFetch([
    // A connection that keeps sending a byte at a time: never stalled, never done.
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            tick = setInterval(() => c.enqueue(new Uint8Array([0])), 10);
          },
          cancel() {
            clearInterval(tick);
          },
        }),
      ),
    () => new Response(BYTES),
  ]);
  const cache = join(tempDir, 'run-a', 'cache', 'npm');
  const r = await seed(beagleRepo(), cache);
  clearInterval(tick);
  assert.equal(r.failed, null);
  assert.equal(calls.length, 2);
  assert.deepEqual(readFileSync(cachePathOf(cache, hexOf(BYTES))), BYTES);
});

test('a redirect off GitHub, or an error answer, is not followed', async () => {
  fakeFetch([
    () => new Response(null, { status: 302, headers: { location: 'https://objects.example.net/beagle.tgz' } }),
    () => new Response('gone', { status: 404 }),
  ]);
  const r = await seed(beagleRepo(), join(tempDir, 'run-a', 'cache', 'npm'));
  assert.match(r.failed ?? '', /beagle/);
  assert.match(r.failed ?? '', /404/);
});

test('a redirect within GitHub is followed', async () => {
  const calls = fakeFetch([
    () => new Response(null, { status: 302, headers: { location: URL_ } }),
    () => new Response(BYTES),
  ]);
  const dir = repoWith({ 'node_modules/beagle': { version: '0.1.0', resolved: `https://github.com/AllStreets/beagle/archive/${SHA}.tar.gz`, integrity: integrityOf(BYTES) } });
  const r = await seed(dir, join(tempDir, 'run-a', 'cache', 'npm'));
  assert.equal(r.failed, null);
  assert.deepEqual(calls, [`https://github.com/AllStreets/beagle/archive/${SHA}.tar.gz`, URL_]);
});

test('a kept tarball that no longer matches is fetched again', async () => {
  const calls = fakeFetch([() => new Response(BYTES), () => new Response(BYTES)]);
  await seed(beagleRepo(), join(tempDir, 'run-a', 'cache', 'npm'));
  // Kept read-only; a disk fault, not a writer, is what changes it.
  chmodSync(join(tarballStore(), `${hexOf(BYTES)}.tgz`), 0o644);
  writeFileSync(join(tarballStore(), `${hexOf(BYTES)}.tgz`), 'rot');
  const r = await seed(beagleRepo(), join(tempDir, 'run-b', 'cache', 'npm'));
  assert.equal(r.failed, null);
  assert.equal(calls.length, 2);
  assert.deepEqual(readFileSync(join(tarballStore(), `${hexOf(BYTES)}.tgz`)), BYTES);
});

test('kept tarballs no lockfile has asked for in 30 days are let go', async () => {
  fakeFetch([() => new Response(BYTES)]);
  mkdirSync(tarballStore(), { recursive: true });
  const old = join(tarballStore(), `${'ab'.repeat(64)}.tgz`);
  writeFileSync(old, 'an old pin');
  const longAgo = new Date(Date.now() - 31 * 86_400_000);
  utimesSync(old, longAgo, longAgo);
  const recent = join(tarballStore(), `${'cd'.repeat(64)}.tgz`);
  writeFileSync(recent, 'a recent pin');
  await seed(beagleRepo(), join(tempDir, 'run-a', 'cache', 'npm'));
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(recent), true);
  assert.ok(statSync(join(tarballStore(), `${hexOf(BYTES)}.tgz`)).isFile());
});

test('a lockfile with nothing pinned on GitHub asks for nothing', async () => {
  const calls = fakeFetch([]);
  const dir = repoWith({ 'node_modules/three': { version: '0.187.0', resolved: 'https://registry.npmjs.org/three/-/three-0.187.0.tgz', integrity: integrityOf(Buffer.from('three')) } });
  const r = await seed(dir, join(tempDir, 'run-a', 'cache', 'npm'));
  assert.equal(r.failed, null);
  assert.deepEqual(calls, []);
});
