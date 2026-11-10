import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { charge, resetBudget } from '../engine/market/budget.js';
import { getSettings } from '../engine/settings.js';
import {
  calibration,
  hookScript,
  installHook,
  isStale,
  latestReading,
  projectsDir,
  readings,
  transcriptTokens,
  uninstallHook,
} from '../engine/usage.js';
import { DEFAULT_TOKENS_PER_PCT } from '../shared/credits.js';

let tempDir: string;
let previousHome: string | undefined;
let previousProjects: string | undefined;
let projects: string;

beforeEach(() => {
  previousHome = process.env.PALIMPSEST_HOME;
  previousProjects = process.env.PALIMPSEST_CLAUDE_PROJECTS;
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-usage-test-'));
  process.env.PALIMPSEST_HOME = tempDir;
  projects = join(tempDir, 'claude-projects');
  mkdirSync(projects, { recursive: true });
  process.env.PALIMPSEST_CLAUDE_PROJECTS = projects;
  resetBudget();
});

afterEach(() => {
  resetBudget();
  if (previousProjects === undefined) delete process.env.PALIMPSEST_CLAUDE_PROJECTS;
  else process.env.PALIMPSEST_CLAUDE_PROJECTS = previousProjects;
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

test('installing twice over a custom statusline chains to the original both times, and uninstall restores byte for byte', () => {
  const settingsPath = join(tempDir, 'claude-settings.json');
  const original =
    JSON.stringify(
      { theme: 'dark', statusLine: { type: 'command', command: 'bash original.sh' }, other: [1, 2, 3] },
      null,
      2,
    ) + '\n';
  writeFileSync(settingsPath, original);

  installHook(settingsPath);
  const scriptAfterFirst = readFileSync(join(tempDir, 'usage', 'statusline.sh'), 'utf8');
  assert.match(scriptAfterFirst, /bash original\.sh/);
  assert.deepEqual(getSettings().previousStatusLine, { type: 'command', command: 'bash original.sh' });

  // Re-installing (idempotent) must not re-capture its own installed state
  // as the backup or as previousStatusLine; it must still chain to the
  // real original.
  installHook(settingsPath);
  const scriptAfterSecond = readFileSync(join(tempDir, 'usage', 'statusline.sh'), 'utf8');
  assert.match(scriptAfterSecond, /bash original\.sh/);
  assert.deepEqual(getSettings().previousStatusLine, { type: 'command', command: 'bash original.sh' });
  assert.equal(getSettings().hookInstalled, true);

  uninstallHook(settingsPath);

  const restored = readFileSync(settingsPath, 'utf8');
  assert.equal(restored, original);
  assert.equal(getSettings().hookInstalled, false);
});

test('uninstall with no prior install leaves a custom statusLine byte for byte unchanged', () => {
  const settingsPath = join(tempDir, 'claude-settings.json');
  const original =
    JSON.stringify(
      { theme: 'dark', statusLine: { type: 'command', command: 'bash custom.sh' }, other: [1, 2, 3] },
      null,
      2,
    ) + '\n';
  writeFileSync(settingsPath, original);

  // installHook was never called: hookInstalled is false and statusLine is not ours.
  uninstallHook(settingsPath);

  const after = readFileSync(settingsPath, 'utf8');
  assert.equal(after, original);
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

test('uninstall keeps a change made to another key since install, and puts only the statusline back', () => {
  const settingsPath = join(tempDir, 'claude-settings.json');
  const original =
    JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'bash original.sh', padding: 2 } }, null, 2) + '\n';
  writeFileSync(settingsPath, original);

  installHook(settingsPath);

  // Claude Code (or the person) changes something unrelated while the hook is installed.
  const installed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(settingsPath, JSON.stringify({ ...installed, model: 'opus', theme: 'light' }, null, 2));

  uninstallHook(settingsPath);

  const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  assert.equal(after.model, 'opus', 'a key added since install survives');
  assert.equal(after.theme, 'light', 'a key changed since install keeps its new value');
  assert.deepEqual(after.statusLine, { type: 'command', command: 'bash original.sh', padding: 2 });
  assert.equal(getSettings().hookInstalled, false);
});

test('uninstall after a change since install removes the statusline when there was none before', () => {
  const settingsPath = join(tempDir, 'claude-settings.json');
  writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }, null, 2));

  installHook(settingsPath);
  const installed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(settingsPath, JSON.stringify({ ...installed, model: 'opus' }, null, 2));

  uninstallHook(settingsPath);

  const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  assert.deepEqual(after, { theme: 'dark', model: 'opus' });
});

test('while installed, the hook keeps the previous statusline settings other than its command', () => {
  const settingsPath = join(tempDir, 'claude-settings.json');
  writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'bash original.sh', padding: 0 } }));

  installHook(settingsPath);
  installHook(settingsPath);

  const statusLine = (JSON.parse(readFileSync(settingsPath, 'utf8')) as { statusLine: Record<string, unknown> }).statusLine;
  assert.equal(statusLine.type, 'command');
  assert.match(String(statusLine.command), /^sh '.*statusline\.sh'$/);
  assert.equal(statusLine.padding, 0);
});

test('reinstalling over a file changed since install does not let uninstall undo that change', () => {
  const settingsPath = join(tempDir, 'claude-settings.json');
  writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: 'command', command: 'bash original.sh' } }, null, 2));

  installHook(settingsPath);
  const installed = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(settingsPath, JSON.stringify({ ...installed, model: 'opus' }, null, 2));
  installHook(settingsPath);

  uninstallHook(settingsPath);

  const after = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.statusLine, { type: 'command', command: 'bash original.sh' });
});

// ---------------------------------------------------------------- transcripts and calibration

const T0 = Date.UTC(2026, 10, 9, 12, 0, 0);
const HOUR = 3_600_000;

interface LineOpts {
  at: number;
  id: string;
  requestId: string;
  model: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

/** One assistant line as Claude Code writes it to a session transcript. */
function assistantLine(o: LineOpts): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: new Date(o.at).toISOString(),
    requestId: o.requestId,
    message: {
      id: o.id,
      model: o.model,
      role: 'assistant',
      usage: {
        input_tokens: o.input ?? 0,
        output_tokens: o.output ?? 0,
        cache_read_input_tokens: o.cacheRead ?? 0,
        cache_creation_input_tokens: o.cacheCreation ?? 0,
      },
    },
  });
}

function writeTranscript(name: string, lines: string[], dir = projects): void {
  const projectDir = join(dir, '-Users-someone-code-thing');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, name), `${lines.join('\n')}\n`);
}

/** Appends readings as the hook writes them (`at` in seconds, resets_at in seconds). */
function writeReadings(rs: Array<{ at: number; five: number; resets: number; seven?: number; sevenResets?: number }>): void {
  const usageDir = join(tempDir, 'usage');
  mkdirSync(usageDir, { recursive: true });
  const text = rs
    .map((r) =>
      JSON.stringify({
        at: Math.floor(r.at / 1000),
        rate_limits: {
          five_hour: { used_percentage: r.five, resets_at: r.resets },
          seven_day: { used_percentage: r.seven ?? 5, resets_at: r.sevenResets ?? Math.floor(T0 / 1000) + 3 * 86_400 },
        },
      }),
    )
    .join('\n');
  writeFileSync(join(usageDir, 'readings.jsonl'), `${text}\n`);
}

test('transcript tokens dedupe by message id and request id', () => {
  writeTranscript('a.jsonl', [
    assistantLine({ at: T0 + 60_000, id: 'msg_1', requestId: 'req_1', model: 'claude-opus-4-1', input: 1000 }),
    // The same message streamed twice: counted once.
    assistantLine({ at: T0 + 61_000, id: 'msg_1', requestId: 'req_1', model: 'claude-opus-4-1', input: 1000 }),
    // Same message id under another request: a distinct call.
    assistantLine({ at: T0 + 62_000, id: 'msg_1', requestId: 'req_2', model: 'claude-opus-4-1', input: 500 }),
    // Outside the range.
    assistantLine({ at: T0 + 2 * HOUR, id: 'msg_9', requestId: 'req_9', model: 'claude-opus-4-1', input: 9999 }),
    JSON.stringify({ type: 'user', timestamp: new Date(T0 + 63_000).toISOString(), message: { role: 'user', content: 'hi' } }),
    'not json at all',
  ]);
  const t = transcriptTokens(T0, T0 + HOUR);
  assert.equal(t.messages, 2);
  assert.equal(t.weighted, 1500);
});

test('readings returns every reading since a time, in order', () => {
  const resets = Math.floor(T0 / 1000) + 3 * 3600;
  writeReadings([
    { at: T0, five: 10, resets },
    { at: T0 + HOUR, five: 12, resets },
    { at: T0 + 2 * HOUR, five: 15, resets },
  ]);
  const rs = readings(T0 + HOUR);
  assert.deepEqual(
    rs.map((r) => r.fiveHour?.usedPercentage),
    [12, 15],
  );
  assert.equal(rs[0].at, T0 + HOUR);
});

test('calibration counts his transcript tokens plus city tokens between readings', () => {
  const resets = Math.floor(T0 / 1000) + 3 * 3600;
  writeReadings([
    { at: T0, five: 10, resets },
    { at: T0 + HOUR, five: 12, resets },
    // A new window: the pair across the reset is not used.
    { at: T0 + 2 * HOUR, five: 1, resets: resets + 5 * 3600 },
  ]);
  writeTranscript('s.jsonl', [
    assistantLine({ at: T0 + 10 * 60_000, id: 'm1', requestId: 'r1', model: 'claude-opus-4-1', input: 100_000 }),
  ]);
  charge({
    runId: 'run-1',
    firmId: 'quickset',
    model: 'claude:opus',
    kind: 'run',
    usage: { weightedTokens: 40_000, seconds: 60, usd: 0, credits: 0 },
    unattended: false,
    at: T0 + 30 * 60_000,
  });

  const c = calibration();
  // observed = (100,000 + 40,000) / 2 = 70,000; blended 0.7 * 60,000 + 0.3 * 70,000.
  assert.equal(c.tokensPerPct, 63_000);
  assert.equal(c.samples, 1);
  assert.equal(c.calibrated, true);

  // Stored, and not counted twice.
  const again = calibration();
  assert.equal(again.tokensPerPct, 63_000);
  assert.equal(again.samples, 1);
  const stored = (getSettings() as unknown as Record<string, { value: number; samples: number }>).tokensPerPct;
  assert.equal(stored.value, 63_000);
  assert.equal(stored.samples, 1);
});

test('calibration with no readings is the assumed prior', () => {
  const c = calibration();
  assert.deepEqual(c, { tokensPerPct: DEFAULT_TOKENS_PER_PCT, calibrated: false, samples: 0 });
});

test('calibration weighs an opus transcript above a haiku one', () => {
  const resets = Math.floor(T0 / 1000) + 3 * 3600;
  const run = (model: string): number => {
    const dir = mkdtempSync(join(tempDir, 'cal-'));
    process.env.PALIMPSEST_HOME = dir;
    process.env.PALIMPSEST_CLAUDE_PROJECTS = join(dir, 'projects');
    const usageDir = join(dir, 'usage');
    mkdirSync(usageDir, { recursive: true });
    writeFileSync(
      join(usageDir, 'readings.jsonl'),
      [
        { at: T0, five: 10 },
        { at: T0 + HOUR, five: 12 },
      ]
        .map((r) => JSON.stringify({ at: r.at / 1000, rate_limits: { five_hour: { used_percentage: r.five, resets_at: resets } } }))
        .join('\n') + '\n',
    );
    writeTranscript('s.jsonl', [assistantLine({ at: T0 + 60_000, id: 'm', requestId: 'r', model, input: 200_000 })], join(dir, 'projects'));
    return calibration().tokensPerPct;
  };
  const opus = run('claude-opus-4-1');
  const haiku = run('claude-haiku-4-5');
  // Opus: observed 100,000, blended 72,000. Haiku: weighted 40,000, observed 20,000, blended 48,000.
  assert.equal(opus, 72_000);
  assert.equal(haiku, 48_000);
  assert.ok(opus > haiku);
});

test('projectsDir defaults under the home directory with no literal tilde', () => {
  delete process.env.PALIMPSEST_CLAUDE_PROJECTS;
  const dir = projectsDir();
  assert.equal(dir, join(homedir(), '.claude', 'projects'));
  assert.ok(!dir.includes('~'));
  process.env.PALIMPSEST_CLAUDE_PROJECTS = projects;
  assert.equal(projectsDir(), projects);
});
