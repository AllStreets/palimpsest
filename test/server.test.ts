import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { realRunner, setRunner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { resetBudget, sseClientCount } from '../engine/market/budget.js';
import { SAMPLE_MARKER } from '../engine/sample.js';
import { enginePort, startServer } from '../engine/server.js';
import type { StartedServer } from '../engine/server.js';

let tempDir: string;
let distDir: string;
let previousHome: string | undefined;
let previousDist: string | undefined;
let settingsPath: string;
let previousUserHome: string | undefined;
let previousClaudeSettings: string | undefined;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  previousDist = process.env.PALIMPSEST_DIST;
  previousUserHome = process.env.HOME;
  previousClaudeSettings = process.env.PALIMPSEST_CLAUDE_SETTINGS;
  delete process.env.PALIMPSEST_CLAUDE_SETTINGS;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-server-test-'));
  distDir = join(tempDir, 'dist-missing'); // does not exist by default
  process.env.PALIMPSEST_HOME = join(tempDir, 'home');
  process.env.PALIMPSEST_DIST = distDir;
  settingsPath = join(tempDir, 'claude-settings.json');
});

afterEach(() => {
  setRunner(realRunner);
  process.env.HOME = previousUserHome;
  if (previousClaudeSettings === undefined) delete process.env.PALIMPSEST_CLAUDE_SETTINGS;
  else process.env.PALIMPSEST_CLAUDE_SETTINGS = previousClaudeSettings;
  if (previousHome === undefined) {
    delete process.env.PALIMPSEST_HOME;
  } else {
    process.env.PALIMPSEST_HOME = previousHome;
  }
  if (previousDist === undefined) {
    delete process.env.PALIMPSEST_DIST;
  } else {
    process.env.PALIMPSEST_DIST = previousDist;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

async function withServer(fn: (server: StartedServer) => Promise<void>): Promise<void> {
  const server = await startServer({ port: 0, claudeSettingsPath: settingsPath });
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

function url(server: StartedServer, path: string): string {
  return `http://127.0.0.1:${server.port}${path}`;
}

function repoViewRow(fullName: string) {
  return {
    nameWithOwner: fullName,
    isPrivate: false,
    description: 'fixture',
    primaryLanguage: { name: 'TypeScript' },
    defaultBranchRef: { name: 'main' },
  };
}

const RS = '\x1e';
const US = '\x1f';

/** A fake Runner serving one successful analyze() run for `fullName`, with no commits and no PRs. */
function fixtureRunner(fullName: string) {
  return async (cmd: string, args: string[]) => {
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') {
      return { stdout: JSON.stringify(repoViewRow(fullName)), stderr: '', code: 0 };
    }
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'clone') {
      return { stdout: '', stderr: '', code: 0 };
    }
    if (cmd === 'git' && args.includes('log')) {
      return { stdout: '', stderr: '', code: 0 };
    }
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      return { stdout: '[]', stderr: '', code: 0 };
    }
    throw new Error(`fixtureRunner: unexpected command ${cmd} ${args.join(' ')}`);
  };
}

/** Polls `check` until it returns true or `timeoutMs` elapses. */
async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitUntil: timed out');
}

test('health reports stopped when the stop file exists', async () => {
  await withServer(async (server) => {
    const before = await fetch(url(server, '/api/health'));
    assert.equal(before.status, 200);
    const beforeBody = (await before.json()) as { ok: boolean; stopped: boolean; version: string };
    assert.equal(beforeBody.ok, true);
    assert.equal(beforeBody.stopped, false);
    assert.equal(typeof beforeBody.version, 'string');

    writeFileSync(paths().stop, '');

    const after = await fetch(url(server, '/api/health'));
    const afterBody = (await after.json()) as { stopped: boolean };
    assert.equal(afterBody.stopped, true);
  });
});

test('writes without the header are refused', async () => {
  await withServer(async (server) => {
    const r = await fetch(url(server, '/api/repos/acme/widgets/connect'), { method: 'POST' });
    assert.equal(r.status, 403);
    const body = (await r.json()) as { error: string };
    assert.ok(body.error);
  });
});

test('writes with the header succeed (repos list unaffected by the guard)', async () => {
  await withServer(async (server) => {
    const r = await fetch(url(server, '/api/settings'), {
      method: 'PATCH',
      headers: { 'x-palimpsest': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ quality: 'medium' }),
    });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { quality: string };
    assert.equal(body.quality, 'medium');
  });
});

test('PATCH /api/settings rejects an invalid quality with 400', async () => {
  await withServer(async (server) => {
    const r = await fetch(url(server, '/api/settings'), {
      method: 'PATCH',
      headers: { 'x-palimpsest': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ quality: 'ultra' }),
    });
    assert.equal(r.status, 400);
  });
});

test('PATCH /api/repos/:owner/:name rejects an invalid root with 400', async () => {
  const fullName = 'acme/widgets';
  setRunner(fixtureRunner(fullName));
  await withServer(async (server) => {
    const connectRes = await fetch(url(server, `/api/repos/${fullName}/connect`), {
      method: 'POST',
      headers: { 'x-palimpsest': '1' },
    });
    assert.equal(connectRes.status, 200);
    await waitUntil(async () => {
      const r = await fetch(url(server, '/api/repos'));
      const repos = (await r.json()) as Array<{ status: string }>;
      return repos.length === 1 && repos[0].status === 'ready';
    });

    const r = await fetch(url(server, `/api/repos/${fullName}`), {
      method: 'PATCH',
      headers: { 'x-palimpsest': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ root: 'brutalist' }),
    });
    assert.equal(r.status, 400);
  });
});

test('PATCH on an unknown repo returns 404', async () => {
  await withServer(async (server) => {
    const r = await fetch(url(server, '/api/repos/acme/ghost'), {
      method: 'PATCH',
      headers: { 'x-palimpsest': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ pushMode: true }),
    });
    assert.equal(r.status, 404);
  });
});

test('connect then city returns a district', async () => {
  const fullName = 'acme/widgets';
  setRunner(fixtureRunner(fullName));

  await withServer(async (server) => {
    const r = await fetch(url(server, `/api/repos/${fullName}/connect`), {
      method: 'POST',
      headers: { 'x-palimpsest': '1' },
    });
    assert.equal(r.status, 200);
    const connected = (await r.json()) as { status: string; connected: boolean };
    assert.equal(connected.connected, true);

    await waitUntil(async () => {
      const cityRes = await fetch(url(server, '/api/city'));
      const districts = (await cityRes.json()) as Array<{ repo: string }>;
      return districts.length === 1 && districts[0].repo === fullName;
    });

    const cityRes = await fetch(url(server, '/api/city'));
    const districts = (await cityRes.json()) as Array<{ repo: string }>;
    assert.equal(districts.length, 1);
    assert.equal(districts[0].repo, fullName);
  });
});

test('gh missing returns 502 with kind missing', async () => {
  setRunner(async () => {
    const err = new Error('spawn gh ENOENT') as Error & { code?: string };
    err.code = 'ENOENT';
    throw err;
  });

  await withServer(async (server) => {
    const r = await fetch(url(server, '/api/repos/available'));
    assert.equal(r.status, 502);
    const body = (await r.json()) as { error: string; kind: string };
    assert.equal(body.kind, 'missing');
    assert.ok(body.error);
  });
});

test('SSE delivers repo.analyzed', async () => {
  const fullName = 'acme/widgets';
  setRunner(fixtureRunner(fullName));

  await withServer(async (server) => {
    const sse = await fetch(url(server, '/api/events'));
    assert.equal(sse.status, 200);
    const reader = sse.body!.getReader();
    const decoder = new TextDecoder();

    const gotAnalyzed = (async () => {
      let buffer = '';
      while (!buffer.includes('event: repo.analyzed')) {
        const { value, done } = await reader.read();
        if (done) throw new Error('SSE stream ended before repo.analyzed arrived');
        buffer += decoder.decode(value);
      }
      return buffer;
    })();

    const connectRes = await fetch(url(server, `/api/repos/${fullName}/connect`), {
      method: 'POST',
      headers: { 'x-palimpsest': '1' },
    });
    assert.equal(connectRes.status, 200);

    const buffer = await Promise.race([
      gotAnalyzed,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timed out waiting for SSE event')), 5000)),
    ]);
    assert.match(buffer, /event: repo\.analyzed/);
    assert.match(buffer, new RegExp(`"fullName":"${fullName.replace('/', '\\/')}"`));

    await reader.cancel();
  });
});

test('SSE connects and disconnects update sseClientCount', async () => {
  resetBudget();
  await withServer(async (server) => {
    assert.equal(sseClientCount(), 0);
    const controller = new AbortController();
    const sse = await fetch(url(server, '/api/events'), { signal: controller.signal });
    assert.equal(sse.status, 200);
    const reader = sse.body!.getReader();
    await reader.read(); // the ': connected' comment
    assert.equal(sseClientCount(), 1);

    controller.abort();
    await reader.cancel().catch(() => undefined);
    const deadline = Date.now() + 5000;
    while (sseClientCount() !== 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(sseClientCount(), 0);
  });
  resetBudget();
});

test('unknown path serves index.html', async () => {
  // Build a fake dist with a marker index.html so the SPA fallback is observable.
  const fs = await import('node:fs');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>palimpsest-fallback-marker</title>');

  await withServer(async (server) => {
    const r = await fetch(url(server, '/some/unknown/client/route'));
    assert.equal(r.status, 200);
    const text = await r.text();
    assert.match(text, /palimpsest-fallback-marker/);
  });
});

test('missing dist returns a plain-text 503 for non-API paths', async () => {
  // distDir is never created in this test, so paths().dist does not exist.
  await withServer(async (server) => {
    const r = await fetch(url(server, '/'));
    assert.equal(r.status, 503);
    const text = await r.text();
    assert.match(text, /UI not built/);
    assert.match(r.headers.get('content-type') ?? '', /text\/plain/);
  });
});

test('static serving rejects path traversal outside dist', async () => {
  const fs = await import('node:fs');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>palimpsest-fallback-marker</title>');
  const secretPath = join(tempDir, 'secret.txt');
  fs.writeFileSync(secretPath, 'top secret');

  await withServer(async (server) => {
    const r = await fetch(url(server, '/../secret.txt'));
    // Browsers/fetch normalize '..' before sending, so hit the raw path via a request that keeps it encoded.
    const r2 = await fetch(url(server, '/%2e%2e/secret.txt'));
    for (const res of [r, r2]) {
      const text = await res.text();
      assert.ok(!text.includes('top secret'), 'must never serve a file outside dist');
    }
  });
});

test('usage hook routes never touch the real claude settings path', async () => {
  const original = '{"theme":"dark"}';
  writeFileSync(settingsPath, original);

  await withServer(async (server) => {
    const install = await fetch(url(server, '/api/usage/hook/install'), {
      method: 'POST',
      headers: { 'x-palimpsest': '1' },
    });
    assert.equal(install.status, 200);

    const usage = await fetch(url(server, '/api/usage'));
    const usageBody = (await usage.json()) as { hookInstalled: boolean };
    assert.equal(usageBody.hookInstalled, true);

    const uninstall = await fetch(url(server, '/api/usage/hook/uninstall'), {
      method: 'POST',
      headers: { 'x-palimpsest': '1' },
    });
    assert.equal(uninstall.status, 200);
  });

  const fs = await import('node:fs');
  const finalContent = fs.readFileSync(settingsPath, 'utf8');
  assert.equal(JSON.parse(finalContent).theme, 'dark');
});

test('POST /api/stop creates and removes the stop file and records both in the ledger', async () => {
  const { entries } = await import('../engine/ledger.js');
  const { existsSync } = await import('node:fs');
  await withServer(async (server) => {
    const post = (body: unknown, headers: Record<string, string> = { 'x-palimpsest': '1', 'content-type': 'application/json' }) =>
      fetch(url(server, '/api/stop'), { method: 'POST', headers, body: JSON.stringify(body) });

    assert.equal((await post({ on: true }, { 'content-type': 'application/json' })).status, 403);
    assert.equal(existsSync(paths().stop), false);
    assert.equal((await post({ on: 'yes' })).status, 400);
    assert.equal((await post({})).status, 400);

    const on = await post({ on: true });
    assert.equal(on.status, 200);
    assert.deepEqual(await on.json(), { stopped: true });
    assert.equal(existsSync(paths().stop), true);
    const health = (await (await fetch(url(server, '/api/health'))).json()) as { stopped: boolean };
    assert.equal(health.stopped, true);

    // Stopping twice is harmless and records nothing new.
    assert.equal((await post({ on: true })).status, 200);

    const off = await post({ on: false });
    assert.deepEqual(await off.json(), { stopped: false });
    assert.equal(existsSync(paths().stop), false);

    const kinds = entries().map((e) => e.kind).filter((k) => k.startsWith('engine.'));
    assert.deepEqual(kinds, ['engine.stopped', 'engine.resumed']);
  });
});

test('enginePort is 4770 unless PALIMPSEST_PORT names another port', () => {
  assert.equal(enginePort({}), 4770);
  assert.equal(enginePort({ PALIMPSEST_PORT: '4790' }), 4790);
  assert.equal(enginePort({ PALIMPSEST_PORT: '' }), 4770);
  for (const bad of ['abc', '0', '70000', '47.5', '-1']) {
    assert.throws(() => enginePort({ PALIMPSEST_PORT: bad }), /PALIMPSEST_PORT/, bad);
  }
});

test('startServer with no port listens on PALIMPSEST_PORT', async () => {
  const previous = process.env.PALIMPSEST_PORT;
  // A free port, found by asking the system for one and letting it go.
  const probe = await startServer({ port: 0, claudeSettingsPath: settingsPath });
  const free = probe.port;
  await probe.close();
  process.env.PALIMPSEST_PORT = String(free);
  try {
    const s = await startServer({ claudeSettingsPath: settingsPath });
    assert.equal(s.port, free);
    const res = await fetch(`http://127.0.0.1:${free}/api/health`);
    assert.equal(res.status, 200);
    await s.close();
  } finally {
    if (previous === undefined) delete process.env.PALIMPSEST_PORT;
    else process.env.PALIMPSEST_PORT = previous;
  }
});

test('repo routes reject a malformed owner/name with 400 before any gh call or stored row', async () => {
  let calls = 0;
  setRunner(async () => {
    calls += 1;
    return { stdout: '', stderr: '', code: 0 };
  });
  await withServer(async (server) => {
    // A literal '..' never arrives: URL parsing folds it away before the request is sent (repos.test.ts covers it).
    const bad = ['-evil/widgets', 'acme/-widgets', 'acme/wid%20gets', 'acme/wid%3Bgets', 'ac%24me/widgets', 'acme/.hidden%60x'];
    for (const path of bad) {
      for (const action of ['connect', 'analyze', 'disconnect']) {
        const r = await fetch(url(server, `/api/repos/${path}/${action}`), { method: 'POST', headers: { 'x-palimpsest': '1' } });
        assert.equal(r.status, 400, `${action} ${path}`);
        const body = (await r.json()) as { error: string };
        assert.match(body.error, /owner\/name/);
      }
      const p = await fetch(url(server, `/api/repos/${path}`), {
        method: 'PATCH',
        headers: { 'x-palimpsest': '1', 'content-type': 'application/json' },
        body: JSON.stringify({ pushMode: true }),
      });
      assert.equal(p.status, 400, `PATCH ${path}`);
    }
    const repos = (await (await fetch(url(server, '/api/repos'))).json()) as unknown[];
    assert.deepEqual(repos, []);
  });
  assert.equal(calls, 0, 'no gh or git call for a malformed name');
});

test('a well formed owner/name with dots, dashes and underscores is accepted', async () => {
  setRunner(fixtureRunner('my-org/my_repo.js'));
  await withServer(async (server) => {
    const r = await fetch(url(server, '/api/repos/my-org/my_repo.js/connect'), { method: 'POST', headers: { 'x-palimpsest': '1' } });
    assert.equal(r.status, 200);
    await waitUntil(async () => {
      const repos = (await (await fetch(url(server, '/api/repos'))).json()) as Array<{ status: string }>;
      return repos[0]?.status === 'ready';
    });
  });
});

/**
 * Points the user's home (os.homedir()) at a fresh temp folder for tests that
 * start the engine without an explicit Claude settings path, so even a broken
 * build can never reach the real ~/.claude/settings.json. Returns the path the
 * real-home settings file would have there.
 */
function fakeUserHome(): string {
  const fake = join(tempDir, 'user-home');
  mkdirSync(fake, { recursive: true });
  process.env.HOME = fake;
  return join(fake, '.claude', 'settings.json');
}

function post(server: StartedServer, path: string): Promise<Response> {
  return fetch(url(server, path), { method: 'POST', headers: { 'x-palimpsest': '1' } });
}

test('an engine on a sample home answers GitHub from the sample and keeps the hook inside the sample home', async () => {
  const userSettings = fakeUserHome();
  const sampleHome = join(tempDir, 'sample');
  mkdirSync(sampleHome, { recursive: true });
  writeFileSync(join(sampleHome, SAMPLE_MARKER), '{}\n');
  process.env.PALIMPSEST_HOME = sampleHome;

  const server = await startServer({ port: 0 });
  try {
    const available = (await (await fetch(url(server, '/api/repos/available'))).json()) as Array<{ fullName: string }>;
    assert.ok(available.some((r) => r.fullName === 'tidewater/harbor-ledger'), 'the sample stand-in answers, not gh');

    assert.equal((await post(server, '/api/usage/hook/install')).status, 200);
    const inSample = JSON.parse(readFileSync(join(sampleHome, 'claude-settings.json'), 'utf8')) as { statusLine: { command: string } };
    assert.match(inSample.statusLine.command, /statusline\.sh/);
    assert.equal((await post(server, '/api/usage/hook/uninstall')).status, 200);
  } finally {
    await server.close();
  }
  assert.equal(existsSync(userSettings), false, 'the user\'s own Claude settings are never written');
});

test('hook routes answer 409 on a non-default home with no Claude settings path given', async () => {
  const userSettings = fakeUserHome();
  const server = await startServer({ port: 0 });
  try {
    for (const path of ['/api/usage/hook/install', '/api/usage/hook/uninstall']) {
      const r = await post(server, path);
      assert.equal(r.status, 409, path);
      const body = (await r.json()) as { error: string };
      assert.match(body.error, /PALIMPSEST_CLAUDE_SETTINGS/);
    }
  } finally {
    await server.close();
  }
  assert.equal(existsSync(userSettings), false);
});

test('PALIMPSEST_CLAUDE_SETTINGS chooses the Claude settings file the hook routes write', async () => {
  const userSettings = fakeUserHome();
  const chosen = join(tempDir, 'chosen-settings.json');
  writeFileSync(chosen, '{"theme":"dark"}');
  process.env.PALIMPSEST_CLAUDE_SETTINGS = chosen;
  const server = await startServer({ port: 0 });
  try {
    assert.equal((await post(server, '/api/usage/hook/install')).status, 200);
    assert.match(readFileSync(chosen, 'utf8'), /statusline\.sh/);
    assert.equal((await post(server, '/api/usage/hook/uninstall')).status, 200);
    assert.equal(readFileSync(chosen, 'utf8'), '{"theme":"dark"}');
  } finally {
    await server.close();
  }
  assert.equal(existsSync(userSettings), false);
});

/** A raw request, so the Host and Origin headers can be set as a browser on another site would send them. */
function rawRequest(
  server: StartedServer,
  path: string,
  headers: Record<string, string>,
  method = 'GET',
): Promise<{ status: number; body: string }> {
  return new Promise((resolveReq, rejectReq) => {
    const req = httpRequest({ host: '127.0.0.1', port: server.port, path, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolveReq({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', rejectReq);
    req.end();
  });
}

test('a request naming another host is refused, so a rebound DNS name cannot reach the engine', async () => {
  await withServer(async (server) => {
    for (const host of [`evil.example:${server.port}`, 'evil.example', `127.0.0.1:${server.port + 1}`, `localhost.evil.example:${server.port}`]) {
      for (const path of ['/api/health', '/api/repos', '/']) {
        const r = await rawRequest(server, path, { host });
        assert.equal(r.status, 403, `${host} ${path}`);
      }
    }
    for (const host of [`127.0.0.1:${server.port}`, `localhost:${server.port}`]) {
      const r = await rawRequest(server, '/api/health', { host });
      assert.equal(r.status, 200, host);
    }
  });
});

test('a request from another site\'s page is refused; the engine\'s own page and the dev server are let through', async () => {
  await withServer(async (server) => {
    const host = `127.0.0.1:${server.port}`;
    for (const origin of ['http://evil.example', `http://evil.example:${server.port}`, 'null', 'http://localhost:4772']) {
      const get = await rawRequest(server, '/api/health', { host, origin });
      assert.equal(get.status, 403, `GET from ${origin}`);
      const post = await rawRequest(server, '/api/stop', { host, origin, 'x-palimpsest': '1', 'content-type': 'application/json' }, 'POST');
      assert.equal(post.status, 403, `POST from ${origin}`);
    }
    for (const origin of [`http://127.0.0.1:${server.port}`, `http://localhost:${server.port}`, 'http://localhost:4771', 'http://127.0.0.1:4771']) {
      const r = await rawRequest(server, '/api/health', { host, origin });
      assert.equal(r.status, 200, origin);
    }
  });
});
