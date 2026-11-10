import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { CLI_DISALLOWED_TOOLS, CLI_PERMISSIONS_DENY } from '../engine/market/guard.js';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'market', 'guard-hook.mjs');

let tempDir: string;
let dir: string;
let dataHome: string;

beforeEach(() => {
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'palimpsest-hook-test-')));
  dataHome = join(tempDir, 'data');
  dir = join(dataHome, 'runs', 'run-1', 'repo');
  mkdirSync(join(dir, '.git'), { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  mkdirSync(join(tempDir, 'home', '.claude'), { recursive: true });
  writeFileSync(join(tempDir, 'home', '.claude', 'settings.json'), '{}\n');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** Runs the hook under plain node (no tsx), with an empty environment, feeding `stdin`. `null` leaves stdin open. */
function runHook(stdin: string | null, argv: string[] = [dir, dataHome], env: Record<string, string> = {}, hook = HOOK, onSpawn?: (pid: number) => void): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook, ...argv], { env: { PATH: '/usr/bin:/bin', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    if (onSpawn && child.pid) onSpawn(child.pid);
    if (stdin !== null) child.stdin.end(stdin);
  });
}

function call(tool_name: string, tool_input: unknown): string {
  return JSON.stringify({ session_id: 's', hook_event_name: 'PreToolUse', cwd: dir, tool_name, tool_input });
}

describe('guard hook', () => {
  test('exits 2 for a forbidden run call', async () => {
    const r = await runHook(call('mcp__palimpsest__run', { command: 'git push --force origin HEAD:main' }));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /push/i);
  });

  test('exits 2 for an Edit outside dir', async () => {
    const r = await runHook(call('Edit', { file_path: join(tempDir, 'home', '.claude', 'settings.json'), old_string: '{}', new_string: '{"x":1}' }));
    assert.equal(r.code, 2);
    assert.ok(r.stderr.length > 0);
  });

  test('exits 2 for an unknown tool', async () => {
    const r = await runHook(call('Bash', { command: 'ls' }));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /tool not allowed in a city run/);
    assert.equal((await runHook(call('WebFetch', { url: 'https://example.com' }))).code, 2);
  });

  test('exits 0 for npm test and an Edit inside dir', async () => {
    assert.equal((await runHook(call('mcp__palimpsest__run', { command: 'npm test' }))).code, 0);
    assert.equal((await runHook(call('Edit', { file_path: join(dir, 'src', 'a.ts'), old_string: '1', new_string: '2' }))).code, 0);
    assert.equal((await runHook(call('Read', { file_path: join(dir, 'src', 'a.ts'), offset: 1, limit: 10 }))).code, 0);
    assert.equal((await runHook(call('Glob', { pattern: 'src/**/*.ts' }))).code, 0);
    assert.equal((await runHook(call('Grep', { pattern: 'export', path: join(dir, 'src') }))).code, 0);
    assert.equal((await runHook(call('MultiEdit', { file_path: join(dir, 'src', 'a.ts'), edits: [{ old_string: '1', new_string: '2' }] }))).code, 0);
  });

  test('exits 2 on unparsable stdin, on an empty body, on a missing file_path and on a non-string path', async () => {
    for (const body of ['{not json', '', '   ', '{"tool_name":"Edit","tool_input":{"file_path":"' + dir]) {
      const r = await runHook(body);
      assert.equal(r.code, 2, `body ${JSON.stringify(body)}`);
      assert.match(r.stderr, /guard could not check this call/);
    }
    for (const input of [{}, { file_path: 7 }, { file_path: null }, { file_path: [join(dir, 'a')] }]) {
      const r = await runHook(call('Write', { content: 'x', ...input }));
      assert.equal(r.code, 2, `input ${JSON.stringify(input)}`);
      assert.match(r.stderr, /guard could not check this call/);
    }
    for (const body of ['null', '[]', '"x"', JSON.stringify({ tool_name: 'Read' }), JSON.stringify({ tool_name: 'Read', tool_input: 'x' })]) {
      const r = await runHook(body);
      assert.equal(r.code, 2, `body ${body}`);
    }
    assert.equal((await runHook(call('mcp__palimpsest__run', { command: ['git', 'push'] }))).code, 2);
    assert.equal((await runHook(call('Glob', { pattern: '*', path: 7 }))).code, 2);
  });

  test('exits 2 for an unexpected path-bearing field', async () => {
    const r = await runHook(call('Read', { file_path: join(dir, 'src', 'a.ts'), other_path: '/etc/passwd' }));
    assert.equal(r.code, 2);
  });

  test('exits 2 for a glob that climbs out of dir or is absolute', async () => {
    assert.equal((await runHook(call('Glob', { pattern: '../../**/*' }))).code, 2);
    assert.equal((await runHook(call('Glob', { pattern: '/Users/*/.claude/**' }))).code, 2);
    assert.equal((await runHook(call('Grep', { pattern: 'token', glob: '../**' }))).code, 2);
  });

  test('exits 2 for an Edit through a symlink', async () => {
    symlinkSync(join(tempDir, 'home', '.claude', 'settings.json'), join(dir, 'settings.json'));
    const r = await runHook(call('Edit', { file_path: join(dir, 'settings.json'), old_string: '{}', new_string: '{"x":1}' }));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /symlink/);
  });

  test('exits 2 without its dir and data home arguments', async () => {
    assert.equal((await runHook(call('mcp__palimpsest__run', { command: 'npm test' }), [])).code, 2);
    assert.equal((await runHook(call('mcp__palimpsest__run', { command: 'npm test' }), [join(tempDir, 'missing'), dataHome])).code, 2);
  });

  test('exits 2 when stdin never ends, by its own timeout', async () => {
    const started = Date.now();
    const r = await runHook(null, [dir, dataHome], { PALIMPSEST_HOOK_TIMEOUT_MS: '300' });
    assert.equal(r.code, 2);
    assert.ok(Date.now() - started < 4000);
  });

  test('a longer timeout from the environment is ignored (5 s at most)', async () => {
    const started = Date.now();
    const r = await runHook(null, [dir, dataHome], { PALIMPSEST_HOOK_TIMEOUT_MS: '600000' });
    assert.equal(r.code, 2);
    assert.ok(Date.now() - started < 8000);
  });

  test('exits 2 when guard-core.mjs is missing or broken', async () => {
    const bin = join(tempDir, 'bin');
    mkdirSync(bin);
    const hook = join(bin, 'guard-hook.mjs');
    copyFileSync(HOOK, hook);
    const okCall = call('mcp__palimpsest__run', { command: 'npm test' });
    const missing = await runHook(okCall, [dir, dataHome], {}, hook);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /guard could not check this call/);
    writeFileSync(join(bin, 'guard-core.mjs'), 'export function forbidden( {\n');
    assert.equal((await runHook(okCall, [dir, dataHome], {}, hook)).code, 2);
    writeFileSync(join(bin, 'guard-core.mjs'), 'export const nothing = 1;\n');
    assert.equal((await runHook(okCall, [dir, dataHome], {}, hook)).code, 2);
    writeFileSync(join(bin, 'guard-core.mjs'), 'throw new Error("load failure");\n');
    assert.equal((await runHook(okCall, [dir, dataHome], {}, hook)).code, 2);
  });

  test('exits 2 when ctl/bin/guard-core.mjs is deleted from an installed run', async () => {
    const prev = process.env.PALIMPSEST_HOME;
    process.env.PALIMPSEST_HOME = dataHome;
    try {
      const { guardHookCommand } = await import('../engine/market/broker.js');
      const runRoot = join(dataHome, 'runs', 'run-1');
      const [node, hook, hookDir, hookHome] = guardHookCommand(runRoot, dir);
      assert.equal(node, process.execPath);
      unlinkSync(join(runRoot, 'ctl', 'bin', 'guard-core.mjs'));
      const r = await runHook(call('mcp__palimpsest__run', { command: 'npm test' }), [hookDir, hookHome], {}, hook);
      assert.equal(r.code, 2);
    } finally {
      if (prev === undefined) delete process.env.PALIMPSEST_HOME;
      else process.env.PALIMPSEST_HOME = prev;
    }
  });

  test('exits 2 when it is sent SIGTERM while waiting', async () => {
    const r = await runHook(null, [dir, dataHome], {}, HOOK, (pid) => setTimeout(() => process.kill(pid, 'SIGTERM'), 300));
    assert.equal(r.code, 2);
  });

  test('exports the deny lists a second layer independent of the hook', () => {
    for (const t of ['Bash', 'WebFetch', 'WebSearch', 'Task']) assert.ok(CLI_DISALLOWED_TOOLS.includes(t), t);
    for (const rule of ['Bash', 'Read(~/.claude/**)', 'Edit(~/.claude/**)', 'Read(~/.config/gh/**)', 'Edit(//**/.git/**)']) {
      assert.ok(CLI_PERMISSIONS_DENY.includes(rule), rule);
    }
  });
});
