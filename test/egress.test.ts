import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { CLAUDE_HOSTS, hostAllowed, hostsFor, startEgress, type Egress } from '../engine/market/egress.js';
import type { RunLogLine } from '../engine/market/provider.js';
import { liveRunPorts } from '../engine/market/sandbox.js';

let tempDir: string;
let previousHome: string | undefined;
let target: Server;
let targetPort: number;
const open: Egress[] = [];

beforeEach(async () => {
  previousHome = process.env.PALIMPSEST_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-egress-test-'));
  process.env.PALIMPSEST_HOME = tempDir;
  // A plain HTTP server on port 0 standing in for a registry.
  target = createServer((req, res) => res.end(`registry ${req.url}`));
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', () => r()));
  targetPort = (target.address() as { port: number }).port;
});

afterEach(async () => {
  for (const e of open.splice(0)) await e.close();
  await new Promise<void>((r) => target.close(() => r()));
  if (previousHome === undefined) delete process.env.PALIMPSEST_HOME;
  else process.env.PALIMPSEST_HOME = previousHome;
  rmSync(tempDir, { recursive: true, force: true });
});

async function start(runId: string, log: RunLogLine[] = []): Promise<Egress> {
  const e = await startEgress(runId, (l) => log.push(l));
  open.push(e);
  return e;
}

function auth(token: string): string {
  return 'Basic ' + Buffer.from(`palimpsest:${token}`).toString('base64');
}

/** Sends a CONNECT through the proxy and resolves with the status line's code; on 200 also speaks HTTP through the tunnel. */
function connectVia(proxyPort: number, host: string, port: number, token: string | null): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const s = connect(proxyPort, '127.0.0.1', () => {
      const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
      if (token !== null) lines.push(`Proxy-Authorization: ${auth(token)}`);
      s.write(lines.join('\r\n') + '\r\n\r\n');
    });
    let buf = '';
    let status = 0;
    s.on('data', (d) => {
      buf += d.toString();
      if (!status) {
        const m = buf.match(/^HTTP\/1\.1 (\d+)/);
        if (m && buf.includes('\r\n\r\n')) {
          status = Number(m[1]);
          if (status === 200) {
            buf = '';
            s.write(`GET /pkg HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
          }
        }
      }
    });
    s.on('end', () => resolve({ status, body: buf }));
    s.on('close', () => resolve({ status, body: buf }));
    s.on('error', reject);
  });
}

/** A plain HTTP forward request through the proxy. */
function getVia(proxyPort: number, url: string, token: string | null): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token !== null) headers['proxy-authorization'] = auth(token);
    const req = request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the token is written to the control dir, read-only, and the port is registered as live', async () => {
  const e = await start('run-a');
  const tokenPath = join(tempDir, 'runs', 'run-a', 'ctl', 'egress.token');
  assert.equal(readFileSync(tokenPath, 'utf8'), e.token);
  assert.equal(statSync(tokenPath).mode & 0o777, 0o400);
  assert.deepEqual(JSON.parse(readFileSync(join(tempDir, 'runs', 'run-a', 'ctl', 'egress.json'), 'utf8')), { port: e.port });
  assert.ok(liveRunPorts().includes(e.port));
  await e.close();
  open.splice(open.indexOf(e), 1);
  assert.ok(!liveRunPorts().includes(e.port));
});

test("a request without this run's token gets 407", async () => {
  const e = await start('run-a');
  e.setStage('install', ['127.0.0.1']);
  assert.equal((await connectVia(e.port, '127.0.0.1', targetPort, null)).status, 407);
  assert.equal((await getVia(e.port, `http://127.0.0.1:${targetPort}/x`, null)).status, 407);
  assert.equal((await connectVia(e.port, '127.0.0.1', targetPort, 'wrong')).status, 407);
  // A malformed token is refused, not a crash.
  assert.equal((await connectVia(e.port, '127.0.0.1', targetPort, '%E0%A4%A')).status, 407);
  assert.equal((await connectVia(e.port, '127.0.0.1', targetPort, e.token)).status, 200);
});

test("another run's token gets 407", async () => {
  const a = await start('run-a');
  const b = await start('run-b');
  a.setStage('install', ['127.0.0.1']);
  b.setStage('install', ['127.0.0.1']);
  assert.notEqual(a.token, b.token);
  assert.equal((await connectVia(a.port, '127.0.0.1', targetPort, b.token)).status, 407);
  assert.equal((await getVia(a.port, `http://127.0.0.1:${targetPort}/x`, b.token)).status, 407);
  assert.equal((await connectVia(b.port, '127.0.0.1', targetPort, a.token)).status, 407);
});

test('a listed host passes and an unlisted host gets 403', async () => {
  const e = await start('run-a');
  e.setStage('install', ['127.0.0.1', '*.npmjs.org']);
  const ok = await connectVia(e.port, '127.0.0.1', targetPort, e.token);
  assert.equal(ok.status, 200);
  assert.match(ok.body, /registry \/pkg/);
  const fwd = await getVia(e.port, `http://127.0.0.1:${targetPort}/left-pad`, e.token);
  assert.equal(fwd.status, 200);
  assert.equal(fwd.body, 'registry /left-pad');
  assert.equal((await connectVia(e.port, 'localhost', targetPort, e.token)).status, 403);
  assert.equal((await connectVia(e.port, 'github.com', 443, e.token)).status, 403);
  assert.equal((await getVia(e.port, 'http://github.com/', e.token)).status, 403);
});

test('setStage checks closes the list', async () => {
  const e = await start('run-a');
  e.setStage('working', ['127.0.0.1']);
  assert.equal((await connectVia(e.port, '127.0.0.1', targetPort, e.token)).status, 200);
  e.setStage('checks', ['127.0.0.1']);
  assert.equal((await connectVia(e.port, '127.0.0.1', targetPort, e.token)).status, 403);
  assert.equal((await getVia(e.port, `http://127.0.0.1:${targetPort}/x`, e.token)).status, 403);
});

test('setStage checks closes tunnels opened in an earlier stage', { timeout: 5000 }, async () => {
  const e = await start('run-a');
  e.setStage('working', ['127.0.0.1']);
  const closed = new Promise<boolean>((resolve) => {
    const s = connect(e.port, '127.0.0.1', () => {
      s.write(`CONNECT 127.0.0.1:${targetPort} HTTP/1.1\r\nProxy-Authorization: ${auth(e.token)}\r\n\r\n`);
    });
    s.once('data', (d) => {
      assert.match(d.toString(), /^HTTP\/1\.1 200/);
      e.setStage('checks', []);
    });
    s.on('close', () => resolve(true));
    s.on('error', () => resolve(true));
  });
  assert.equal(await closed, true);
});

test('a fresh proxy allows nothing until a stage is set', async () => {
  const e = await start('run-a');
  assert.equal((await connectVia(e.port, '127.0.0.1', targetPort, e.token)).status, 403);
});

test('every decision is logged', async () => {
  const log: RunLogLine[] = [];
  const e = await start('run-a', log);
  e.setStage('install', ['127.0.0.1']);
  await connectVia(e.port, '127.0.0.1', targetPort, null);
  await connectVia(e.port, '127.0.0.1', targetPort, e.token);
  await connectVia(e.port, 'evil.example', 443, e.token);
  await getVia(e.port, 'http://evil.example/', e.token);
  const decisions = log.filter((l) => l.kind === 'egress' && /^(allowed|refused) /.test(l.text));
  assert.equal(decisions.length, 4);
  assert.match(decisions[0].text, /^refused CONNECT 127\.0\.0\.1:\d+ .*no token/);
  assert.match(decisions[1].text, /^allowed CONNECT 127\.0\.0\.1:\d+/);
  assert.match(decisions[2].text, /^refused CONNECT evil\.example:443/);
  assert.match(decisions[3].text, /^refused GET evil\.example:80/);
  assert.ok(log.every((l) => l.kind === 'egress' && typeof l.at === 'string'));
});

test('hostAllowed matches exact hosts and listed suffixes only', () => {
  assert.ok(hostAllowed('registry.npmjs.org', ['registry.npmjs.org']));
  assert.ok(hostAllowed('a.b.npmjs.org', ['*.npmjs.org']));
  assert.ok(!hostAllowed('npmjs.org', ['*.npmjs.org']));
  assert.ok(!hostAllowed('evilnpmjs.org', ['*.npmjs.org']));
  assert.ok(!hostAllowed('registry.npmjs.org.evil.com', ['registry.npmjs.org']));
});

test('hostsFor follows ruling 21', () => {
  assert.deepEqual(hostsFor('install', ['npm'], 'claude:sonnet'), ['registry.npmjs.org']);
  assert.deepEqual(hostsFor('install', ['python', 'rust', 'go'], null), [
    'pypi.org', 'files.pythonhosted.org', 'index.crates.io', 'static.crates.io', 'crates.io', 'proxy.golang.org', 'sum.golang.org',
  ]);
  assert.deepEqual(hostsFor('working', ['npm'], 'claude:opus'), ['registry.npmjs.org', ...CLAUDE_HOSTS]);
  assert.deepEqual(hostsFor('working', ['npm'], 'ollama:qwen3:1.7b'), ['registry.npmjs.org']);
  assert.deepEqual(hostsFor('checks', ['npm'], 'claude:opus'), []);
  assert.deepEqual(CLAUDE_HOSTS, ['api.anthropic.com']);
  for (const stage of ['install', 'working'] as const) {
    assert.ok(!hostsFor(stage, ['npm', 'python', 'rust', 'go'], 'claude:opus').some((h) => /github/.test(h)));
  }
});
