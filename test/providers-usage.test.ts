/**
 * Provider usage for Settings (Task 19). Every reader points at a temp dir or a
 * fixture; no real Codex, Gemini, Ollama or Claude config and no network is used.
 */
import assert from 'node:assert/strict';
import fs, { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createServer, type Server } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import { realRunner, setRunner, type Runner } from '../engine/exec.js';
import { claudeUsage, codexHome, geminiHome, geminiUsage, mlxUsage, ollamaUsage, openaiUsage, anthropicApiUsage, parseOllamaList, providerUsages, READ_CAP, resetProviderCache } from '../engine/providers-usage.js';
import { SYSTEM_PATH } from '../engine/market/sandbox.js';
import { patchSettings } from '../engine/settings.js';

const ENV_KEYS = ['PALIMPSEST_HOME', 'PALIMPSEST_CODEX_HOME', 'PALIMPSEST_GEMINI_HOME', 'PALIMPSEST_CLAUDE_PROJECTS', 'PALIMPSEST_TEST_PROJECTS', 'PALIMPSEST_CLAUDE_SETTINGS'];
const FIXTURES = join(import.meta.dirname, 'fixtures');
let previousEnv: Record<string, string | undefined>;
let tempDir: string;
let server: Server | null = null;
const NOW = Date.parse('2026-11-10T15:00:00Z');

beforeEach(() => {
  resetProviderCache();
  previousEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'palimpsest-provusage-test-')));
  process.env.PALIMPSEST_HOME = join(tempDir, 'data');
  process.env.PALIMPSEST_CLAUDE_PROJECTS = join(tempDir, 'projects');
  process.env.PALIMPSEST_TEST_PROJECTS = '1';
  delete process.env.PALIMPSEST_CLAUDE_SETTINGS;
  process.env.PALIMPSEST_CODEX_HOME = join(tempDir, 'no-codex');
  process.env.PALIMPSEST_GEMINI_HOME = join(tempDir, 'no-gemini');
});

afterEach(async () => {
  setRunner(realRunner);
  if (server) await new Promise((r) => server!.close(r));
  server = null;
  for (const k of ENV_KEYS) {
    if (previousEnv[k] === undefined) delete process.env[k];
    else process.env[k] = previousEnv[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

/** A stand-in that answers `ollama list` with `models`, as the CLI prints them; nothing real runs. */
function ollamaList(models: string[]): Runner {
  return async (cmd, args) => {
    if (cmd !== 'ollama' || args[0] !== 'list') throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
    const rows = models.map((m) => `${m.padEnd(32)}5a17c0de1234    4.7 GB    3 weeks ago`);
    return { stdout: `NAME                            ID              SIZE      MODIFIED\n${rows.join('\n')}\n`, stderr: '', code: 0 };
  };
}

function codexFixture(): string {
  const dest = join(tempDir, 'codex');
  cpSync(join(FIXTURES, 'codex'), dest, { recursive: true });
  const file = join(dest, 'sessions', '2026', '11', '10', 'rollout-a.jsonl');
  const t = new Date(NOW - 3600_000);
  utimesSync(file, t, t);
  return dest;
}

describe('provider usage', () => {
  test('the homes default under the home dir and obey the env', () => {
    process.env.PALIMPSEST_CODEX_HOME = '/x/c';
    process.env.PALIMPSEST_GEMINI_HOME = '/x/g';
    assert.equal(codexHome(), '/x/c');
    assert.equal(geminiHome(), '/x/g');
  });

  test('under tests an unset home is a missing folder in the temp dir, never ~/.codex or ~/.gemini', () => {
    delete process.env.PALIMPSEST_CODEX_HOME;
    delete process.env.PALIMPSEST_GEMINI_HOME;
    for (const home of [codexHome(), geminiHome()]) {
      assert.ok(home.startsWith(realpathSync(tmpdir())) || home.startsWith(tmpdir()), `${home} lies in the temp dir`);
      assert.ok(!home.startsWith(homedir()), `${home} is not under his home`);
      assert.equal(fs.existsSync(home), false);
    }
    assert.equal(openaiUsage(NOW).status, 'not-found');
    assert.equal(geminiUsage(NOW).status, 'not-found');
    // Outside a test run the defaults are the CLIs' own folders.
    assert.equal(codexHome({}), join(homedir(), '.codex'));
    assert.equal(geminiHome({}), join(homedir(), '.gemini'));
  });

  test('the readers are bounded: the tail of a big Codex log, a capped number of files, oversized Gemini chats skipped', () => {
    const dir = join(tempDir, 'big-codex');
    const day = join(dir, 'sessions', '2026', '11', '10');
    mkdirSync(day, { recursive: true });
    const line = (pct: number, total: number) => JSON.stringify({ timestamp: '2026-11-10T14:00:00Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { total_tokens: total } }, rate_limits: { primary: { used_percent: pct, window_minutes: 300 }, secondary: { used_percent: 1, window_minutes: 10080 } } } });
    // A token line at the head, then more than the cap of padding, then the latest line: only the tail is read.
    const pad = `${JSON.stringify({ type: 'other', text: 'x'.repeat(1000) })}\n`.repeat(Math.ceil((READ_CAP.bytes * 1.5) / 1000));
    const big = join(day, 'rollout-big.jsonl');
    writeFileSync(big, `${line(99, 10)}\n${pad}${line(33, 500)}\n`);
    const at = new Date(NOW - 60_000);
    utimesSync(big, at, at);
    const readSpy = mock.method(fs, 'readFileSync');
    syncBuiltinESMExports();
    process.env.PALIMPSEST_CODEX_HOME = dir;
    try {
      const u = openaiUsage(NOW);
      assert.equal(u.windows[0]?.usedPct, 33, 'the windows come from the tail');
      assert.ok(readSpy.mock.calls.every((c) => !String(c.arguments[0]).endsWith('rollout-big.jsonl')), 'the big file is never read whole');
    } finally {
      readSpy.mock.restore();
      syncBuiltinESMExports();
    }

    // More session files than the cap: only the newest are read.
    const many = join(tempDir, 'many-codex', 'sessions', '2026', '11', '10');
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < READ_CAP.files + 15; i++) {
      const f = join(many, `rollout-${i}.jsonl`);
      writeFileSync(f, `${line(5, 100)}\n`);
      const t = new Date(NOW - (i + 1) * 60_000);
      utimesSync(f, t, t);
    }
    process.env.PALIMPSEST_CODEX_HOME = join(tempDir, 'many-codex');
    assert.equal(openaiUsage(NOW).tokens?.week, READ_CAP.files * 100, `at most ${READ_CAP.files} files are read`);

    // A Gemini chat over the cap is skipped, not parsed.
    const chats = join(tempDir, 'big-gemini', 'tmp', 'p', 'chats');
    mkdirSync(chats, { recursive: true });
    const chat = join(chats, 'session-big.json');
    writeFileSync(chat, JSON.stringify({ messages: [{ timestamp: '2026-11-10T14:00:00Z', tokens: { total: 7 } }], pad: 'y'.repeat(READ_CAP.bytes + 10) }));
    utimesSync(chat, at, at);
    process.env.PALIMPSEST_GEMINI_HOME = join(tempDir, 'big-gemini');
    assert.equal(geminiUsage(NOW).tokens, null, 'nothing read from a chat over the cap');
  });

  test('Settings reads the CLIs at most once a minute', async () => {
    process.env.PALIMPSEST_CODEX_HOME = codexFixture();
    patchSettings({ ollamaHost: '127.0.0.1:1' });
    const first = (await providerUsages()).find((p) => p.provider === 'openai');
    assert.equal(first?.status, 'ready');
    rmSync(process.env.PALIMPSEST_CODEX_HOME, { recursive: true, force: true });
    assert.deepEqual((await providerUsages()).find((p) => p.provider === 'openai'), first, 'a second read within the minute is the cached one');
    resetProviderCache();
    assert.equal((await providerUsages()).find((p) => p.provider === 'openai')?.status, 'not-found');
  });

  test('codex windows come from the last token_count line', () => {
    process.env.PALIMPSEST_CODEX_HOME = codexFixture();
    const u = openaiUsage(NOW);
    assert.equal(u.provider, 'openai');
    assert.equal(u.status, 'ready');
    assert.deepEqual(u.windows, [
      { label: '5 hours', usedPct: 42, resetsAt: 1794000000 },
      { label: 'week', usedPct: 17.5, resetsAt: 1794500000 },
    ]);
    // 1000 then 2500 then 4000 cumulative: deltas 1000 + 1500 + 1500, all after local midnight.
    assert.deepEqual(u.tokens, { today: 4000, week: 4000 });
  });

  test('codex not installed reports not found', () => {
    const u = openaiUsage(NOW);
    assert.equal(u.status, 'not-found');
    assert.equal(u.detail, 'Codex CLI not found on this Mac');
    assert.deepEqual(u.windows, []);
  });

  test('codex auth.json is never opened', () => {
    const dir = codexFixture();
    writeFileSync(join(dir, 'auth.json'), '{"secret":"SURFACE-ME"}');
    process.env.PALIMPSEST_CODEX_HOME = dir;
    const opened: string[] = [];
    for (const name of ['readFileSync', 'openSync', 'statSync', 'createReadStream'] as const) {
      const orig = (fs as any)[name];
      mock.method(fs as any, name, (...args: any[]) => {
        opened.push(String(args[0]));
        return orig.apply(fs, args);
      });
    }
    syncBuiltinESMExports();
    try {
      const u = openaiUsage(NOW);
      assert.equal(u.status, 'ready');
      assert.ok(opened.length > 0, 'the spy sees reads');
      assert.deepEqual(opened.filter((p) => p.includes('auth.json')), []);
      assert.ok(!JSON.stringify(u).includes('SURFACE-ME'));
    } finally {
      mock.restoreAll();
      syncBuiltinESMExports();
    }
  });

  test('codex labels come from window_minutes and no sessions means unknown tokens', () => {
    const dir = join(tempDir, 'codex2');
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    assert.equal(openaiUsage(NOW).status, 'not-found');
    process.env.PALIMPSEST_CODEX_HOME = dir;
    assert.equal(openaiUsage(NOW).tokens, null);
    const f = join(dir, 'sessions', 'r.jsonl');
    writeFileSync(f, JSON.stringify({ type: 'token_count', rate_limits: { primary: { used_percent: 1, window_minutes: 10080, resets_at: 5 }, secondary: { used_percent: 2, window_minutes: 300, resets_at: 6 } } }) + '\n');
    utimesSync(f, new Date(NOW - 1000), new Date(NOW - 1000));
    assert.deepEqual(openaiUsage(NOW).windows.map((w) => w.label), ['week', '5 hours']);
  });

  test('an unreadable codex session dir degrades without throwing', () => {
    const dir = join(tempDir, 'codex3');
    mkdirSync(join(dir, 'sessions'), { recursive: true });
    chmodSync(join(dir, 'sessions'), 0o000);
    process.env.PALIMPSEST_CODEX_HOME = dir;
    try {
      const u = openaiUsage(NOW);
      assert.equal(u.tokens, null);
    } finally {
      chmodSync(join(dir, 'sessions'), 0o700);
    }
  });

  test('corrupt gemini json and no chats are unknown, not zero', () => {
    const dir = join(tempDir, 'gem2');
    assert.equal((mkdirSync(join(dir, 'tmp', 'a', 'chats'), { recursive: true }), geminiUsage(NOW).status), 'not-found');
    process.env.PALIMPSEST_GEMINI_HOME = dir;
    assert.equal(geminiUsage(NOW).tokens, null);
    const f = join(dir, 'tmp', 'a', 'chats', 'bad.json');
    writeFileSync(f, '{ not json');
    utimesSync(f, new Date(NOW - 1000), new Date(NOW - 1000));
    const u = geminiUsage(NOW);
    assert.equal(u.status, 'ready');
    assert.equal(u.tokens, null);
  });

  test('a throwing reader shows that provider as unknown and keeps the list', async () => {
    patchSettings({ ollamaHost: '127.0.0.1:1' });
    const list = await providerUsages({ claude: () => { throw new Error('boom'); }, 'anthropic-api': () => { throw new Error('bang'); } });
    assert.deepEqual(list.map((p) => p.provider), ['claude', 'anthropic-api', 'ollama', 'openai', 'gemini', 'mlx']);
    assert.equal(list[0].status, 'unknown');
    assert.match(list[0].detail, /boom/);
    assert.equal(list[1].status, 'unknown');
    assert.equal(list[2].status, 'not-found');
    assert.equal(typeof claudeUsage, 'function');
  });

  test('an ollama database error is not reported as unreachable', async () => {
    setRunner(ollamaList(['qwen3:1.7b']));
    const u = await ollamaUsage(NOW, () => { throw new Error('db down'); });
    assert.equal(u.status, 'ready');
    assert.match(u.detail, /credits unknown/);
  });

  test('gemini sums tokens and has no windows', () => {
    const dest = join(tempDir, 'gemini');
    cpSync(join(FIXTURES, 'gemini'), dest, { recursive: true });
    process.env.PALIMPSEST_GEMINI_HOME = dest;
    const u = geminiUsage(NOW);
    assert.equal(u.provider, 'gemini');
    assert.equal(u.status, 'ready');
    assert.deepEqual(u.windows, []);
    assert.deepEqual(u.tokens, { today: 300, week: 350 });
  });

  test('gemini not installed reports not found', () => {
    assert.equal(geminiUsage(NOW).status, 'not-found');
  });

  test('the api provider is off until enabled', () => {
    assert.equal(anthropicApiUsage().status, 'off');
    patchSettings({ anthropicApi: { enabled: true, dailyUsd: 5 } });
    const u = anthropicApiUsage();
    assert.equal(u.status, 'ready');
    assert.deepEqual(u.spendUsd, { today: 0, week: 0 });
  });

  test('mlx arrives later', () => {
    const u = mlxUsage();
    assert.equal(u.status, 'later');
    assert.equal(u.detail, 'arrives with the school');
  });

  test('ollama is read through `ollama list` at his host: unreachable, then reachable with its models', async () => {
    patchSettings({ ollamaHost: '127.0.0.1:11500' });
    const calls: Array<{ cmd: string; args: string[]; env?: Record<string, string> }> = [];
    setRunner(async (cmd, args, opts) => {
      calls.push({ cmd, args, env: opts?.env });
      return { stdout: '', stderr: 'Error: could not connect to ollama app, is it running?', code: 1 };
    });
    const down = await ollamaUsage();
    assert.equal(down.status, 'not-found');
    assert.equal(down.host, '127.0.0.1:11500');
    assert.match(down.detail, /not reachable at 127\.0\.0\.1:11500/);
    assert.deepEqual(calls.map((c) => [c.cmd, ...c.args]), [['ollama', 'list']]);
    assert.equal(calls[0].env?.OLLAMA_HOST, 'http://127.0.0.1:11500', 'asked at his configured host');

    setRunner(ollamaList(['qwen3:1.7b', 'gpt-oss:20b']));
    const u = await ollamaUsage();
    assert.equal(u.status, 'ready');
    assert.deepEqual(u.models, ['qwen3:1.7b', 'gpt-oss:20b']);
    assert.match(u.detail, /2 models installed/);
    assert.deepEqual(u.tokens, null);

    setRunner(async () => {
      throw new Error('spawn ollama ENOENT');
    });
    assert.equal((await ollamaUsage()).status, 'not-found', 'no ollama on this Mac reads as not reachable');
  });

  test('`ollama list` is run on the system PATH, and rows that are not models are skipped', async () => {
    let env: Record<string, string> | undefined;
    setRunner(async (_cmd, _args, opts) => {
      env = opts?.env;
      return { stdout: 'NAME    ID    SIZE    MODIFIED\nqwen3:1.7b    8f68893c685c    1.4 GB    3 weeks ago\nWarning: could not connect to a running Ollama instance\n\nerror: something\n', stderr: '', code: 0 };
    });
    const u = await ollamaUsage();
    assert.equal(env?.PATH, SYSTEM_PATH.join(':'));
    assert.deepEqual(u.models, ['qwen3:1.7b']);
    assert.deepEqual(parseOllamaList('NAME ID SIZE MODIFIED\nWARNING: old client\ngpt-oss:20b  aa70e1f3bc2d  13 GB  now\n'), ['gpt-oss:20b']);
  });

  test('the list is in the fixed order', async () => {
    patchSettings({ ollamaHost: '127.0.0.1:1' });
    const list = await providerUsages();
    assert.deepEqual(
      list.map((p) => p.provider),
      ['claude', 'anthropic-api', 'ollama', 'openai', 'gemini', 'mlx'],
    );
  });
});
