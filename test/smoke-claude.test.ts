/**
 * The opt-in smoke run (Task 11): only its refusals and its reading of the
 * stream are tested here. No test runs the real claude: a fake spawner
 * replays an init line (test safety rules 4 and 10), and the claude binary
 * named in the argv is a stub that is never executed.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { getSpawner, realSpawner, setSpawner, type SpawnLine, type Spawned } from '../engine/exec.js';
import { defaultHome } from '../engine/home.js';
import { initFailures, runSmoke, smokeRefusal } from '../tools/smoke-claude.js';

const ENV_KEYS = ['PALIMPSEST_HOME', 'PALIMPSEST_SMOKE', 'PALIMPSEST_SANDBOX', 'PALIMPSEST_PORT'];
let previousEnv: Record<string, string | undefined>;
let tempDir: string;
let claudeBin: string;

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'palimpsest-smoke-test-')));
  process.env.PALIMPSEST_HOME = join(tempDir, 'data');
  delete process.env.PALIMPSEST_SMOKE;
  delete process.env.PALIMPSEST_SANDBOX;
  delete process.env.PALIMPSEST_PORT;
  mkdirSync(join(tempDir, 'bin'), { recursive: true });
  claudeBin = join(tempDir, 'bin', 'claude');
  writeFileSync(claudeBin, '#!/bin/sh\nexit 1\n');
  chmodSync(claudeBin, 0o755);
});

afterEach(() => {
  setSpawner(realSpawner);
  for (const k of ENV_KEYS) {
    if (previousEnv[k] === undefined) delete process.env[k];
    else process.env[k] = previousEnv[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

const GOOD_INIT = {
  type: 'system',
  subtype: 'init',
  model: 'claude-haiku-4-5',
  apiKeySource: 'none',
  tools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'mcp__palimpsest__run'],
  mcp_servers: [{ name: 'palimpsest', status: 'connected' }],
  plugins: [],
};

/** A fake claude: replays `events` for any argv that carries `-p`, and records every spawn. */
function fakeClaude(events: unknown[]): { argvs: string[][] } {
  const argvs: string[][] = [];
  setSpawner((cmd, args): Spawned => {
    argvs.push([cmd, ...args]);
    let finished = false;
    let resolveDone!: (d: { code: number | null; signal: string | null }) => void;
    const done = new Promise<{ code: number | null; signal: string | null }>((r) => (resolveDone = r));
    const out = args.includes('-p') ? events : [];
    async function* lines(): AsyncGenerator<SpawnLine> {
      try {
        for (const e of out) {
          if (finished) return;
          yield { stream: 'stdout', line: JSON.stringify(e) };
          await new Promise((r) => setImmediate(r));
        }
      } finally {
        finished = true;
        resolveDone({ code: 0, signal: null });
      }
    }
    return {
      pid: 434343,
      lines: lines(),
      kill() {
        finished = true;
      },
      done,
    };
  });
  return { argvs };
}

describe('smoke run refusals', () => {
  test('the smoke script refuses without PALIMPSEST_SMOKE, on the real home and with the stop file present', async () => {
    assert.match(smokeRefusal() ?? '', /PALIMPSEST_SMOKE=1/);

    process.env.PALIMPSEST_SMOKE = '1';
    assert.equal(smokeRefusal(), null, 'a fresh temp home with the switch on is allowed');

    delete process.env.PALIMPSEST_HOME;
    assert.match(smokeRefusal() ?? '', /PALIMPSEST_HOME/);
    process.env.PALIMPSEST_HOME = defaultHome();
    assert.match(smokeRefusal() ?? '', /real data home/);
    process.env.PALIMPSEST_HOME = join(defaultHome(), '..', 'Palimpsest');
    assert.match(smokeRefusal() ?? '', /real data home/, 'however it is spelled');
    process.env.PALIMPSEST_HOME = join(process.env.HOME ?? '/Users/x', 'palimpsest-smoke');
    assert.match(smokeRefusal() ?? '', /temp/, 'a home outside the temp dir is refused');

    process.env.PALIMPSEST_HOME = join(tempDir, 'data');
    mkdirSync(join(tempDir, 'data'), { recursive: true });
    writeFileSync(join(tempDir, 'data', 'STOP'), '');
    assert.match(smokeRefusal() ?? '', /stop file/);
    rmSync(join(tempDir, 'data', 'STOP'));

    process.env.PALIMPSEST_SANDBOX = 'off';
    assert.match(smokeRefusal() ?? '', /sandbox/);
    delete process.env.PALIMPSEST_SANDBOX;

    process.env.PALIMPSEST_PORT = '4770';
    assert.match(smokeRefusal() ?? '', /4770/);
  });

  test('runSmoke itself refuses and spawns nothing while a refusal holds', async () => {
    const { argvs } = fakeClaude([GOOD_INIT]);
    await assert.rejects(runSmoke({ claudeBin, attacks: false, kernelLog: false, quiet: async () => {}, print: () => {} }), /PALIMPSEST_SMOKE=1/);
    assert.equal(argvs.length, 0);
  });
});

describe('smoke run reading', () => {
  test('initFailures accepts exactly the city tools, the one MCP server and no plugins', () => {
    assert.deepEqual(initFailures(GOOD_INIT), []);
    assert.deepEqual(initFailures(null), ['no system/init line']);
    assert.match(initFailures({ ...GOOD_INIT, tools: [...GOOD_INIT.tools, 'Bash'] }).join(), /tools/);
    assert.match(initFailures({ ...GOOD_INIT, tools: ['Read'] }).join(), /tools/, 'a missing tool fails too');
    assert.match(initFailures({ ...GOOD_INIT, mcp_servers: [{ name: 'palimpsest' }, { name: 'github' }] }).join(), /MCP/);
    assert.match(initFailures({ ...GOOD_INIT, plugins: [{ name: 'x', path: '/p' }] }).join(), /plugins/);
  });

  test('it reports a non-none apiKeySource as a failure', async () => {
    process.env.PALIMPSEST_SMOKE = '1';
    const { argvs } = fakeClaude([{ ...GOOD_INIT, apiKeySource: 'ANTHROPIC_API_KEY' }]);
    const printed: string[] = [];
    const report = await runSmoke({ claudeBin, attacks: false, kernelLog: false, quiet: async () => {}, print: (l) => printed.push(l) });
    assert.ok(argvs.some((a) => a.includes('-p') && a.includes(claudeBin)), 'the fake claude ran');
    assert.ok(report.failures.some((f) => /apiKeySource ANTHROPIC_API_KEY/.test(f)), report.failures.join('\n'));
    assert.equal(report.ended, 'crashed');
    assert.match(printed.join('\n'), /apiKeySource: ANTHROPIC_API_KEY/);
    assert.match(printed.join('\n'), /FAIL/);
  });

  test('the work call runs haiku on a throwaway repo with no GitHub remote', async () => {
    process.env.PALIMPSEST_SMOKE = '1';
    const { argvs } = fakeClaude([GOOD_INIT]);
    const report = await runSmoke({ claudeBin, attacks: false, kernelLog: false, quiet: async () => {}, print: () => {} });
    const claude = argvs.find((a) => a.includes('-p'))!;
    assert.equal(claude[claude.indexOf('--model') + 1], 'haiku');
    assert.ok(!report.remotes.some((r) => /github/i.test(r)), report.remotes.join('\n'));
    assert.ok(report.failures.some((f) => /hook/.test(f)), 'a run whose hook never fired fails');
  });

  test("the proof the hook ran is claude's hook_response event, not the display marker file", async () => {
    process.env.PALIMPSEST_SMOKE = '1';
    fakeClaude([GOOD_INIT, { type: 'system', subtype: 'hook_response', hook_name: 'PreToolUse:Read', exit_code: 0, outcome: 'success' }]);
    const report = await runSmoke({ claudeBin, attacks: false, kernelLog: false, quiet: async () => {}, print: () => {} });
    assert.ok(!report.failures.some((f) => /hook/.test(f)), report.failures.join('\n'));
    assert.deepEqual(report.hookMarkers, [], 'no marker file was written, and none is needed');
  });

  test('--nested-sandbox writes the nested sandbox settings', async () => {
    process.env.PALIMPSEST_SMOKE = '1';
    let settings = '';
    const { argvs } = fakeClaude([GOOD_INIT]);
    const inner = getSpawner();
    setSpawner((cmd, args, opts) => {
      const i = args.indexOf('--settings');
      if (i >= 0) settings = readFileSync(args[i + 1], 'utf8');
      return inner(cmd, args, opts);
    });
    const report = await runSmoke({ claudeBin, nested: true, attacks: false, kernelLog: false, quiet: async () => {}, print: () => {} });
    assert.ok(argvs.length > 0);
    assert.deepEqual(JSON.parse(settings).sandbox, { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false });
    assert.equal(report.nested, true);
  });

  test('without --nested-sandbox the plain call carries no sandbox settings', async () => {
    process.env.PALIMPSEST_SMOKE = '1';
    let settings = '';
    fakeClaude([GOOD_INIT]);
    const inner = getSpawner();
    setSpawner((cmd, args, opts) => {
      const i = args.indexOf('--settings');
      if (i >= 0) settings = readFileSync(args[i + 1], 'utf8');
      return inner(cmd, args, opts);
    });
    const report = await runSmoke({ claudeBin, attacks: false, kernelLog: false, quiet: async () => {}, print: () => {} });
    assert.equal(JSON.parse(settings).sandbox, undefined);
    assert.equal(report.nested, null);
  });
});
