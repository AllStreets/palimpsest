import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { getRunner } from './exec.js';
import { paths } from './home.js';

export const LABEL = 'com.palimpsest.engine';

export interface PlistOptions {
  /** Absolute path to the node binary (process.execPath). */
  node: string;
  /** Absolute path to the repo root (WorkingDirectory; engine/main.ts is resolved relative to it). */
  repo: string;
  /** Absolute path to the logs directory (paths().logs); stdout/stderr both go to <logs>/engine.log. */
  logs: string;
  /** The PATH value launchd should hand the process, e.g. including /opt/homebrew/bin:/usr/local/bin. */
  path: string;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** The launchd agent plist, as XML text. Runs `node --import tsx <repo>/engine/main.ts`, restarted by KeepAlive. */
export function plist(o: PlistOptions): string {
  const mainPath = join(o.repo, 'engine', 'main.ts');
  const logPath = join(o.logs, 'engine.log');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(o.node)}</string>
    <string>--import</string>
    <string>tsx</string>
    <string>${xmlEscape(mainPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(o.repo)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(o.path)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

function launchAgentsDir(): string {
  return join(homedir(), 'Library', 'LaunchAgents');
}

function plistPath(): string {
  return join(launchAgentsDir(), `${LABEL}.plist`);
}

/** The repo root, resolved from this module's own location (engine/launchd.ts is one level under it). */
function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

/** PATH for the launchd agent: the current PATH with /opt/homebrew/bin and /usr/local/bin ensured present, in that order, first. */
function agentPath(): string {
  const base = (process.env.PATH ?? '/usr/bin:/bin').split(':').filter((p) => p !== '');
  const required = ['/opt/homebrew/bin', '/usr/local/bin'];
  const merged = [...required, ...base.filter((p) => !required.includes(p))];
  return merged.join(':');
}

function gui(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

/**
 * Writes the launchd plist to `~/Library/LaunchAgents/com.palimpsest.engine.plist`
 * and loads it with `launchctl bootstrap`. Idempotent: an agent already
 * bootstrapped is booted out first (failure ignored) so re-running install()
 * always ends with the freshly written plist loaded.
 */
export async function install(): Promise<void> {
  mkdirSync(launchAgentsDir(), { recursive: true });

  const content = plist({
    node: process.execPath,
    repo: repoRoot(),
    logs: paths().logs,
    path: agentPath(),
  });
  writeFileSync(plistPath(), content);

  const runner = getRunner();
  await runner('launchctl', ['bootout', `${gui()}/${LABEL}`]).catch(() => undefined);

  const result = await runner('launchctl', ['bootstrap', gui(), plistPath()]);
  if (result.code !== 0) {
    throw new Error(`launchctl bootstrap failed: ${(result.stderr || result.stdout).trim()}`);
  }
}

/** Unloads the agent with `launchctl bootout` (failure ignored: it may not be loaded) and removes the plist file. */
export async function uninstall(): Promise<void> {
  const runner = getRunner();
  await runner('launchctl', ['bootout', `${gui()}/${LABEL}`]).catch(() => undefined);
  if (existsSync(plistPath())) {
    rmSync(plistPath());
  }
}

/** 'running' when launchctl print shows a live pid, 'installed' when only the plist file exists, else 'absent'. */
export async function status(): Promise<'running' | 'installed' | 'absent'> {
  const runner = getRunner();
  const result = await runner('launchctl', ['print', `${gui()}/${LABEL}`]).catch(() => ({
    stdout: '',
    stderr: '',
    code: 1,
  }));
  if (result.code === 0 && /\bpid\s*=\s*\d+/.test(result.stdout)) {
    return 'running';
  }
  if (existsSync(plistPath())) {
    return 'installed';
  }
  return 'absent';
}
