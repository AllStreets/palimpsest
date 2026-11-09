import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { getSettings } from '../engine/settings.js';
import { hookScript, installHook, isStale, latestReading, uninstallHook } from '../engine/usage.js';

let tempDir: string;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-usage-test-'));
  process.env.PALIMPSEST_HOME = tempDir;
});

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env.PALIMPSEST_HOME;
  } else {
    process.env.PALIMPSEST_HOME = previousHome;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

/** Writes `script` to a temp file, chmods it executable, runs it under `sh` with `stdin`, and returns the result. */
function runScript(script: string, stdin: string): { stdout: string; stderr: string; status: number | null } {
  const scriptPath = join(tempDir, 'statusline-under-test.sh');
  writeFileSync(scriptPath, script, { mode: 0o755 });
  const result = spawnSync('sh', [scriptPath], { input: stdin, encoding: 'utf8' });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

function readLines(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '');
}

test('hook records rate limits and chains the previous statusline', () => {
  const stdin = JSON.stringify({
    rate_limits: { five_hour: { used_percentage: 42, resets_at: 1700000000 } },
  });

  const result = runScript(hookScript('printf previous'), stdin);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'previous');

  const readings = readLines(join(tempDir, 'usage', 'readings.jsonl'));
  assert.equal(readings.length, 1);
  const parsed = JSON.parse(readings[0]) as { rate_limits: { five_hour: { used_percentage: number } } };
  assert.equal(parsed.rate_limits.five_hour.used_percentage, 42);

  const latest = JSON.parse(readFileSync(join(tempDir, 'usage', 'latest.json'), 'utf8')) as {
    rate_limits: { five_hour: { used_percentage: number } };
  };
  assert.equal(latest.rate_limits.five_hour.used_percentage, 42);

  const reading = latestReading();
  assert.ok(reading);
  assert.equal(reading?.fiveHour?.usedPercentage, 42);
  assert.equal(reading?.fiveHour?.resetsAt, 1700000000);
  assert.equal(reading?.sevenDay, null);
});

test('hook without rate_limits records nothing', () => {
  const stdin = JSON.stringify({ model: 'opus', some_other_field: true });

  const result = runScript(hookScript(null), stdin);

  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.equal(latestReading(), null);
});

test('hook only appends to readings.jsonl when rate_limits changed, but always overwrites latest.json', () => {
  const stdin = JSON.stringify({
    rate_limits: { five_hour: { used_percentage: 10, resets_at: 1700000000 } },
  });

  runScript(hookScript(null), stdin);
  runScript(hookScript(null), stdin);

  const readings = readLines(join(tempDir, 'usage', 'readings.jsonl'));
  assert.equal(readings.length, 1);

  const changedStdin = JSON.stringify({
    rate_limits: { five_hour: { used_percentage: 20, resets_at: 1700000000 } },
  });
  runScript(hookScript(null), changedStdin);

  const after = readLines(join(tempDir, 'usage', 'readings.jsonl'));
  assert.equal(after.length, 2);

  const latest = JSON.parse(readFileSync(join(tempDir, 'usage', 'latest.json'), 'utf8')) as {
    rate_limits: { five_hour: { used_percentage: number } };
  };
  assert.equal(latest.rate_limits.five_hour.used_percentage, 20);
});

test('install then uninstall restores settings byte for byte', () => {
  const settingsPath = join(tempDir, 'claude-settings.json');
  const original =
    '{\n' +
    '  "theme" :   "dark",\n' +
    '  "statusLine":   { "type": "command",   "command": "bash /Users/connorevans/.claude/statusline.sh" },\n' +
    '  "other"  : [1,2,3]\n' +
    '}\n';
  writeFileSync(settingsPath, original);

  installHook(settingsPath);

  const afterInstall = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    statusLine: { type: string; command: string };
  };
  assert.equal(afterInstall.statusLine.type, 'command');
  assert.match(afterInstall.statusLine.command, /^sh '.*statusline\.sh'$/);
  assert.equal(getSettings().hookInstalled, true);
  assert.deepEqual(getSettings().previousStatusLine, {
    type: 'command',
    command: 'bash /Users/connorevans/.claude/statusline.sh',
  });

  // The installed script chains to the original custom statusline.
  const scriptPath = join(tempDir, 'usage', 'statusline.sh');
  const installedScript = readFileSync(scriptPath, 'utf8');
  assert.match(installedScript, /bash \/Users\/connorevans\/\.claude\/statusline\.sh/);

  uninstallHook(settingsPath);

  const restored = readFileSync(settingsPath, 'utf8');
  assert.equal(restored, original);
  assert.equal(getSettings().hookInstalled, false);
});

test('installing a second time does not chain the hook to itself', () => {
  const settingsPath = join(tempDir, 'claude-settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({ statusLine: { type: 'command', command: 'bash original.sh' } }, null, 2),
  );

  installHook(settingsPath);
  installHook(settingsPath);

  const scriptPath = join(tempDir, 'usage', 'statusline.sh');
  const installedScript = readFileSync(scriptPath, 'utf8');

  // The hook's own command must never appear as the thing it chains to.
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine: { command: string } };
  assert.ok(!installedScript.includes(`'${settings.statusLine.command}'`));
});

test('uninstall when statusLine was changed by something else only resets statusLine', () => {
  const settingsPath = join(tempDir, 'claude-settings.json');
  writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'bash original.sh' } }));

  installHook(settingsPath);

  // Something else (not Palimpsest) changed statusLine after install.
  const tampered = { statusLine: { type: 'command', command: 'bash someone-else.sh' }, extra: true };
  writeFileSync(settingsPath, JSON.stringify(tampered));

  uninstallHook(settingsPath);

  const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    statusLine: { command: string };
    extra: boolean;
  };
  assert.equal(after.statusLine.command, 'bash original.sh');
  assert.equal(after.extra, true);
  assert.equal(getSettings().hookInstalled, false);
});

test('stale after five hours', () => {
  const now = Date.now();
  const fresh = { at: now - 60_000, fiveHour: null, sevenDay: null };
  const old = { at: now - 5 * 60 * 60 * 1000 - 1, fiveHour: null, sevenDay: null };
  const boundary = { at: now - 5 * 60 * 60 * 1000, fiveHour: null, sevenDay: null };

  assert.equal(isStale(fresh, now), false);
  assert.equal(isStale(old, now), true);
  assert.equal(isStale(boundary, now), false);
});
