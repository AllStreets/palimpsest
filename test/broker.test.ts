import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { getSpawner, realSpawner, setSpawner, type Spawner } from '../engine/exec.js';
import { entries } from '../engine/ledger.js';
import {
  MAX_SPOOL_BYTES,
  MAX_TOOL_MS,
  brokerMcpServer,
  execFileTool,
  execTool,
  spoolUsed,
  startBroker,
  setSpoolUsedForTests,
  type Broker,
} from '../engine/market/broker.js';
import type { RunLogLine } from '../engine/market/provider.js';
import { liveRunPorts } from '../engine/market/sandbox.js';

const ENV_KEYS = ['PALIMPSEST_HOME', 'PALIMPSEST_SANDBOX', 'PALIMPSEST_BROKER_TEST_SENTINEL'];
let previousEnv: Record<string, string | undefined>;
let tempDir: string;
const open: Broker[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'palimpsest-broker-test-')));
  process.env.PALIMPSEST_HOME = join(tempDir, 'data');
  process.env.PALIMPSEST_SANDBOX = 'off';
  process.env.PALIMPSEST_BROKER_TEST_SENTINEL = 'leaked';
  mkdirSync(join(tempDir, 'home', '.config', 'gh'), { recursive: true });
  writeFileSync(join(tempDir, 'home', '.config', 'gh', 'hosts.yml'), 'github.com:\n  oauth_token: stand-in\n');
  mkdirSync(join(tempDir, 'home', '.claude'), { recursive: true });
  writeFileSync(join(tempDir, 'home', '.claude', 'settings.json'), '{"stand":"in"}\n');
});

afterEach(async () => {
  for (const c of children.splice(0)) c.kill('SIGKILL');
  for (const b of open.splice(0)) await b.close();
  setSpawner(realSpawner);
  for (const k of ENV_KEYS) {
    if (previousEnv[k] === undefined) delete process.env[k];
    else process.env[k] = previousEnv[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

/** A run root shaped like createRunDir's, without a clone. */
function makeRun(runId: string): { runId: string; runRoot: string; dir: string } {
  const runRoot = join(tempDir, 'data', 'runs', runId);
  const dir = join(runRoot, 'repo');
  for (const d of ['repo/.git', 'repo/src', 'tmp', 'home', 'cache', 'ctl']) mkdirSync(join(runRoot, d), { recursive: true });
  writeFileSync(join(dir, '.git', 'config'), '[core]\n\tbare = false\n');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  return { runId, runRoot, dir };
}

function base(run: { runId: string; runRoot: string; dir: string }, log: RunLogLine[], signal = new AbortController().signal) {
  return { ...run, stage: 'working' as const, signal, log: (l: RunLogLine) => log.push(l) };
}

function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

describe('execTool', () => {
  test('a forbidden command is refused, recorded and never spawned', async () => {
    const run = makeRun('run-refuse');
    const spawned: string[][] = [];
    const real = getSpawner();
    setSpawner(((cmd, args, opts) => {
      spawned.push([cmd, ...args]);
      return real(cmd, args, opts);
    }) as Spawner);
    const log: RunLogLine[] = [];
    const marker = join(tempDir, 'pushed');
    const r = await execTool({ ...base(run, log), command: `git push origin main; touch ${marker}`, timeoutMs: 5000 });
    assert.ok(r.refused);
    assert.equal(r.code, null);
    assert.equal(spawned.length, 0);
    assert.throws(() => statSync(marker));
    assert.ok(log.some((l) => l.kind === 'refused' && l.text.includes(r.refused as string)));
    const rec = entries().filter((e) => e.kind === 'run.refused');
    assert.equal(rec.length, 1);
    assert.equal((rec[0].data as { runId: string }).runId, 'run-refuse');
  });

  test('an allowed command runs in dir with the child environment', async () => {
    const run = makeRun('run-env');
    const log: RunLogLine[] = [];
    const r = await execTool({ ...base(run, log), command: 'echo "$HOME"; pwd; echo "sentinel=${PALIMPSEST_BROKER_TEST_SENTINEL:-none}"; echo "token=${GH_TOKEN:-none}"', timeoutMs: 10_000 });
    assert.equal(r.refused, null);
    assert.equal(r.code, 0);
    const [homeLine, pwdLine, sentinel, gh] = r.stdout.trim().split('\n');
    assert.equal(homeLine, join(run.runRoot, 'home'));
    assert.equal(realpathSync(pwdLine), realpathSync(run.dir));
    assert.equal(sentinel, 'sentinel=none');
    assert.equal(gh, 'token=none');
    assert.ok(log.some((l) => l.kind === 'tool' && l.text.includes(join(run.runRoot, 'home'))));
  });

  test('a run context outside the runs directory is refused', async () => {
    const log: RunLogLine[] = [];
    const elsewhere = join(tempDir, 'elsewhere');
    mkdirSync(join(elsewhere, 'repo'), { recursive: true });
    const r = await execTool({ runId: 'x', runRoot: elsewhere, dir: join(elsewhere, 'repo'), command: 'true', timeoutMs: 1000, stage: 'working', signal: new AbortController().signal, log: (l) => log.push(l) });
    assert.ok(r.refused);
    const run = makeRun('run-dir');
    const r2 = await execTool({ ...base(run, log), dir: tempDir, command: 'true', timeoutMs: 1000 });
    assert.ok(r2.refused);
  });

  test('timeoutMs above the cap is clamped', async () => {
    const run = makeRun('run-clamp');
    const seen: Array<number | undefined> = [];
    setSpawner(((cmd, args, opts) => {
      seen.push(opts.maxMs);
      return realSpawner('/usr/bin/true', [], { clearEnv: true });
    }) as Spawner);
    const log: RunLogLine[] = [];
    await execTool({ ...base(run, log), command: 'true', timeoutMs: 10 * 60 * 60_000 });
    await execTool({ ...base(run, log), command: 'true', timeoutMs: 5 });
    await execTool({ ...base(run, log), command: 'true', timeoutMs: Number.NaN });
    assert.deepEqual(seen, [MAX_TOOL_MS, 1000, MAX_TOOL_MS]);
    assert.equal(MAX_TOOL_MS, 15 * 60_000);
    assert.ok(log.some((l) => /cut to/.test(l.text)));
  });

  test('a timed-out command is killed and says so', async () => {
    const run = makeRun('run-timeout');
    const started = Date.now();
    const r = await execTool({ ...base(run, []), command: 'sleep 30', timeoutMs: 1000 });
    assert.ok(Date.now() - started < 8000);
    assert.match(r.stderr, /timed out/);
  });

  test('the spool stops growing at the cap and says so', async () => {
    const run = makeRun('run-spool');
    const log: RunLogLine[] = [];
    setSpoolUsedForTests(run.runId, MAX_SPOOL_BYTES - 1000);
    const cmd = 'i=0; while [ $i -lt 3000 ]; do echo "line $i of the flood with some padding to make it longer"; i=$((i+1)); done';
    const r1 = await execTool({ ...base(run, log), command: cmd, timeoutMs: 20_000 });
    assert.equal(r1.code, 0);
    const bytes = () => log.filter((l) => l.kind === 'tool').reduce((n, l) => n + Buffer.byteLength(l.text) + 1, 0);
    const after1 = bytes();
    assert.ok(after1 <= 4096 * 2 + 1000, `first call logged ${after1} bytes`);
    assert.ok(log.some((l) => /bytes of output dropped/.test(l.text)));
    assert.ok(log.some((l) => l.text.includes('line 0 of')));
    assert.ok(log.some((l) => l.text.includes('line 2999 of')));
    const used1 = spoolUsed(run.runId);
    await execTool({ ...base(run, log), command: cmd, timeoutMs: 20_000 });
    const grew = bytes() - after1;
    assert.ok(grew <= 4096 * 2 + 200, `second call logged ${grew} bytes`);
    assert.ok(spoolUsed(run.runId) - used1 <= 4096 * 2 + 200);
    // The caller's copy is capped at 64 KB per side.
    const big = await execTool({ ...base(run, []), command: 'head -c 200000 /dev/zero | tr "\\0" a', timeoutMs: 20_000 });
    assert.ok(big.stdout.length <= 64 * 1024 + 200);
    assert.match(big.stdout, /truncated/);
  });

  test('aborting the signal kills the command', async () => {
    const run = makeRun('run-abort');
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 300);
    const r = await execTool({ ...base(run, [], ac.signal), command: 'sleep 30', timeoutMs: 60_000 });
    assert.ok(Date.now() - started < 6000, 'the command outlived the abort');
    assert.notEqual(r.code, 0);
    // An already aborted signal runs nothing.
    const marker = join(run.dir, 'ran');
    const r2 = await execTool({ ...base(run, [], ac.signal), command: `touch ${marker}`, timeoutMs: 5000 });
    assert.notEqual(r2.code, 0);
    assert.throws(() => statSync(marker));
  });
});

describe('execFileTool', () => {
  test('reads, writes, edits, lists and searches inside dir', async () => {
    const run = makeRun('run-files');
    const log: RunLogLine[] = [];
    const w = await execFileTool({ ...base(run, log), op: 'write', args: { path: 'src/new/b.ts', content: 'export const b = 2;\n' } });
    assert.equal(w.refused, null, w.stderr);
    assert.equal(readFileSync(join(run.dir, 'src', 'new', 'b.ts'), 'utf8'), 'export const b = 2;\n');
    const e = await execFileTool({ ...base(run, log), op: 'edit', args: { path: 'src/new/b.ts', old: '2', new: '3' } });
    assert.equal(e.refused, null, e.stderr);
    const rd = await execFileTool({ ...base(run, log), op: 'read', args: { path: 'src/new/b.ts' } });
    assert.match(rd.stdout, /const b = 3/);
    const ls = await execFileTool({ ...base(run, log), op: 'list', args: { path: 'src' } });
    assert.match(ls.stdout, /a\.ts/);
    const s = await execFileTool({ ...base(run, log), op: 'search', args: { pattern: 'const b' } });
    assert.match(s.stdout, /b\.ts/);
  });

  test('file-tool read through a symlink to a temp hosts.yml stand-in is refused', async () => {
    const run = makeRun('run-sym-read');
    symlinkSync(join(tempDir, 'home', '.config', 'gh', 'hosts.yml'), join(run.dir, 'hosts.yml'));
    const r = await execFileTool({ ...base(run, []), op: 'read', args: { path: 'hosts.yml' } });
    assert.ok(r.refused);
    assert.doesNotMatch(r.stdout + r.stderr, /stand-in/);
  });

  test('file-tool write through a symlink to a temp settings.json stand-in is refused and the target is unchanged', async () => {
    const run = makeRun('run-sym-write');
    const target = join(tempDir, 'home', '.claude', 'settings.json');
    symlinkSync(target, join(run.dir, 'settings.json'));
    const r = await execFileTool({ ...base(run, []), op: 'write', args: { path: 'settings.json', content: '{"hooks":"evil"}' } });
    assert.ok(r.refused);
    assert.equal(readFileSync(target, 'utf8'), '{"stand":"in"}\n');
    const e = await execFileTool({ ...base(run, []), op: 'edit', args: { path: 'settings.json', old: 'stand', new: 'evil' } });
    assert.ok(e.refused);
    assert.equal(readFileSync(target, 'utf8'), '{"stand":"in"}\n');
  });

  test('file-tool write through a symlink to .git/config is refused', async () => {
    const run = makeRun('run-sym-git');
    symlinkSync(join(run.dir, '.git', 'config'), join(run.dir, 'gitconfig'));
    const before = readFileSync(join(run.dir, '.git', 'config'), 'utf8');
    const r = await execFileTool({ ...base(run, []), op: 'write', args: { path: 'gitconfig', content: '[core]\n\thooksPath = /tmp\n' } });
    assert.ok(r.refused);
    const direct = await execFileTool({ ...base(run, []), op: 'write', args: { path: '.git/config', content: 'x' } });
    assert.ok(direct.refused);
    assert.equal(readFileSync(join(run.dir, '.git', 'config'), 'utf8'), before);
  });

  test('the file tool never follows a symlink while listing or searching', async () => {
    const run = makeRun('run-sym-list');
    symlinkSync(join(tempDir, 'home', '.config', 'gh'), join(run.dir, 'gh'));
    const s = await execFileTool({ ...base(run, []), op: 'search', args: { pattern: 'oauth_token' } });
    assert.doesNotMatch(s.stdout, /stand-in/);
    const ls = await execFileTool({ ...base(run, []), op: 'list', args: { path: 'gh' } });
    assert.ok(ls.refused);
  });

  test('the file tool stops at the guard even when called directly', () => {
    const run = makeRun('run-direct');
    symlinkSync(join(tempDir, 'home', '.config', 'gh', 'hosts.yml'), join(run.dir, 'hosts.yml'));
    const script = join(process.cwd(), 'engine', 'market', 'file-tool.mjs');
    let out = '';
    try {
      out = execFileSync(process.execPath, [script, run.dir, 'read', JSON.stringify({ path: 'hosts.yml' })], { encoding: 'utf8', env: {} });
    } catch (err) {
      out = String((err as { stdout?: string }).stdout ?? '');
    }
    assert.doesNotMatch(out, /stand-in/);
    assert.match(out, /symlink/);
  });
});

describe('startBroker', () => {
  test('a request without the token gets 401 and another run\'s token gets 401', async () => {
    const a = makeRun('run-a');
    const b = makeRun('run-b');
    const logA: RunLogLine[] = [];
    const brokerA = await startBroker(a.runId, { runRoot: a.runRoot, dir: a.dir, log: (l) => logA.push(l), signal: new AbortController().signal });
    open.push(brokerA);
    const brokerB = await startBroker(b.runId, { runRoot: b.runRoot, dir: b.dir, log: () => {}, signal: new AbortController().signal });
    open.push(brokerB);
    const tokenA = readFileSync(join(a.runRoot, 'ctl', 'broker.token'), 'utf8').trim();
    const tokenB = readFileSync(join(b.runRoot, 'ctl', 'broker.token'), 'utf8').trim();
    assert.equal(statSync(join(a.runRoot, 'ctl', 'broker.token')).mode & 0o777, 0o400);
    assert.notEqual(tokenA, tokenB);

    assert.equal((await post(brokerA.port, '/run', { command: 'true' })).status, 401);
    assert.equal((await post(brokerA.port, '/run', { command: 'true' }, { authorization: `Bearer ${tokenB}` })).status, 401);
    assert.equal((await post(brokerA.port, '/run', { command: 'true' }, { authorization: 'Bearer ' })).status, 401);
    assert.ok(logA.some((l) => l.kind === 'refused' && /token/.test(l.text)));

    const ok = await post(brokerA.port, '/run', { command: 'echo hi', timeoutMs: 5000 }, { authorization: `Bearer ${tokenA}` });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).stdout, 'hi\n');
    const refused = await post(brokerA.port, '/run', { command: 'gh pr merge 1' }, { authorization: `Bearer ${tokenA}` });
    assert.equal(refused.status, 200);
    assert.ok(JSON.parse(refused.body).refused);
  });

  test('the broker registers its port and writes it to broker.json', async () => {
    const a = makeRun('run-port');
    const broker = await startBroker(a.runId, { runRoot: a.runRoot, dir: a.dir, log: () => {}, signal: new AbortController().signal });
    open.push(broker);
    assert.ok(liveRunPorts().includes(broker.port));
    assert.equal(JSON.parse(readFileSync(join(a.runRoot, 'ctl', 'broker.json'), 'utf8')).port, broker.port);
    await broker.close();
    open.splice(open.indexOf(broker), 1);
    assert.ok(!liveRunPorts().includes(broker.port));
  });

  test('the token is on no argv', async () => {
    const a = makeRun('run-argv');
    const broker = await startBroker(a.runId, { runRoot: a.runRoot, dir: a.dir, log: () => {}, signal: new AbortController().signal });
    open.push(broker);
    const token = readFileSync(join(a.runRoot, 'ctl', 'broker.token'), 'utf8').trim();
    const server = brokerMcpServer(a.runRoot);
    for (const arg of [server.command, ...server.args]) assert.ok(!arg.includes(token));
    const child = spawn(server.command, server.args, { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    await new Promise((r) => setTimeout(r, 200));
    const ps = execFileSync('/bin/ps', ['-ww', '-o', 'args=', '-p', String(child.pid)], { encoding: 'utf8' });
    assert.match(ps, /broker-mcp\.mjs/);
    assert.ok(!ps.includes(token));
  });

  test('the MCP server lists one tool and forwards a call', async () => {
    const a = makeRun('run-mcp');
    const broker = await startBroker(a.runId, { runRoot: a.runRoot, dir: a.dir, log: () => {}, signal: new AbortController().signal });
    open.push(broker);
    const server = brokerMcpServer(a.runRoot);
    const child = spawn(server.command, server.args, { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
    children.push(child);
    let buf = '';
    const waiting = new Map<number, (v: unknown) => void>();
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id: number };
        waiting.get(msg.id)?.(msg);
      }
    });
    const rpc = (id: number, method: string, params: unknown = {}) =>
      new Promise<any>((resolve) => {
        waiting.set(id, resolve);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    const init = await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
    assert.equal(init.result.serverInfo.name, 'palimpsest');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const list = await rpc(2, 'tools/list');
    assert.equal(list.result.tools.length, 1);
    assert.equal(list.result.tools[0].name, 'run');
    assert.equal(list.result.tools[0].description, 'Run a shell command in the repository. The city refuses pushes, credentials and anything outside the repository.');
    const call = await rpc(3, 'tools/call', { name: 'run', arguments: { command: 'echo forwarded; pwd' } });
    assert.equal(call.result.isError, false);
    assert.match(call.result.content[0].text, /forwarded/);
    assert.match(call.result.content[0].text, /exit code 0/);
    const refused = await rpc(4, 'tools/call', { name: 'run', arguments: { command: 'git push origin main' } });
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /refused/i);
    const unknown = await rpc(5, 'tools/call', { name: 'other', arguments: {} });
    assert.ok(unknown.error || unknown.result.isError);
  });
});

describe('under the tool profile', () => {
  const skip = process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec') ? 'sandbox-exec is missing' : false;

  test('commands and file tools run under the sandbox, and what the guard misses the sandbox still refuses', { skip }, async () => {
    process.env.PALIMPSEST_SANDBOX = 'on';
    const run = makeRun('run-sandboxed');
    const log: RunLogLine[] = [];
    const ok = await execTool({ ...base(run, log), command: 'echo hi; cat src/a.ts', timeoutMs: 20_000 });
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /export const a/);
    assert.ok(readFileSync(join(run.runRoot, 'ctl', 'tool.sb'), 'utf8').includes('(deny default)'));

    // The guard does not see through a variable in a redirect target; the sandbox refuses the write.
    const before = readFileSync(join(run.dir, '.git', 'config'), 'utf8');
    const sneaky = await execTool({ ...base(run, log), command: 'p=.gi; echo "[core] hooksPath=/tmp" > ${p}t/config', timeoutMs: 20_000 });
    assert.equal(sneaky.refused, null);
    assert.notEqual(sneaky.code, 0);
    assert.equal(readFileSync(join(run.dir, '.git', 'config'), 'utf8'), before);

    // A file outside the run root (the temp stand-in for hosts.yml) is unreadable to a command.
    const standIn = join(tempDir, 'home', '.config', 'gh', 'hosts.yml');
    const leak = await execTool({ ...base(run, log), command: `cat ${standIn.replace('/.config/gh/', '/.config/x/../gh/')}`, timeoutMs: 20_000 });
    assert.equal(leak.refused, null);
    assert.notEqual(leak.code, 0);
    assert.doesNotMatch(leak.stdout, /stand-in/);

    const w = await execFileTool({ ...base(run, log), op: 'write', args: { path: 'src/b.ts', content: 'export const b = 1;\n' } });
    assert.equal(w.refused, null, w.stderr);
    assert.equal(readFileSync(join(run.dir, 'src', 'b.ts'), 'utf8'), 'export const b = 1;\n');
    symlinkSync(standIn, join(run.dir, 'hosts.yml'));
    const r = await execFileTool({ ...base(run, log), op: 'read', args: { path: 'hosts.yml' } });
    assert.ok(r.refused);
    assert.doesNotMatch(r.stdout, /stand-in/);
  });
});
