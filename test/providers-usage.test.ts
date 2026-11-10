/**
 * Provider usage for Settings (Task 19). Every reader points at a temp dir or a
 * fixture; no real Codex, Gemini, Ollama or Claude config and no network is used.
 */
import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { codexHome, geminiHome, geminiUsage, mlxUsage, ollamaUsage, openaiUsage, anthropicApiUsage, providerUsages } from '../engine/providers-usage.js';
import { patchSettings } from '../engine/settings.js';

const ENV_KEYS = ['PALIMPSEST_HOME', 'PALIMPSEST_CODEX_HOME', 'PALIMPSEST_GEMINI_HOME', 'PALIMPSEST_CLAUDE_PROJECTS', 'PALIMPSEST_TEST_PROJECTS', 'PALIMPSEST_CLAUDE_SETTINGS'];
const FIXTURES = join(import.meta.dirname, 'fixtures');
let previousEnv: Record<string, string | undefined>;
let tempDir: string;
let server: Server | null = null;
const NOW = Date.parse('2026-11-10T15:00:00Z');

beforeEach(() => {
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
  if (server) await new Promise((r) => server!.close(r));
  server = null;
  for (const k of ENV_KEYS) {
    if (previousEnv[k] === undefined) delete process.env[k];
    else process.env[k] = previousEnv[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

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
    writeFileSync(join(dir, 'auth.json'), '{"secret":"x"}');
    chmodSync(join(dir, 'auth.json'), 0o000);
    process.env.PALIMPSEST_CODEX_HOME = dir;
    try {
      assert.equal(openaiUsage(NOW).status, 'ready');
    } finally {
      chmodSync(join(dir, 'auth.json'), 0o600);
    }
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

  test('ollama is reported unreachable, then reachable with its models', async () => {
    patchSettings({ ollamaHost: '127.0.0.1:1' });
    assert.equal((await ollamaUsage()).status, 'not-found');
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'qwen3:1.7b' }, { name: 'gpt-oss:20b' }] }));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    patchSettings({ ollamaHost: `127.0.0.1:${port}` });
    const u = await ollamaUsage();
    assert.equal(u.status, 'ready');
    assert.match(u.detail, /2 models/);
    assert.deepEqual(u.tokens, null);
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
