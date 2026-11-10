/**
 * The two sandbox-exec profiles every agent child runs under (ruling 9).
 *
 * - The tool profile bounds every command an agent runs, the install stage,
 *   every check and the push-mode recheck.
 * - The CLI profile bounds the claude process alone, which has no shell
 *   tool (ruling 19) and reaches the broker through an MCP tool.
 *
 * Both are deny by default. Seatbelt applies the last matching rule, so the
 * order of every block below matters and is tested by execution:
 * the home deny comes before the run root allows, the named secret denies
 * come after every allow, and the port denies come after the loopback allow.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync, chmodSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { home as dataHomeDir, isRealDataHome } from '../home.js';

export interface ProfileInput {
  /** `<home>/runs/<runId>` (or a baseline or scratch root). */
  runRoot: string;
  /** His home directory (the one whose reads are denied). */
  home: string;
  /** The Palimpsest data home (inside his home on the real Mac). */
  dataHome: string;
  /** The engine's API port: never reachable from a sandboxed child. */
  enginePort: number;
  /** This run's egress proxy port. */
  proxyPort: number;
  /** Toolchain directories under his home that tools may read (detectToolchains). */
  toolchains: string[];
  /**
   * Loopback ports of other live runs (their proxies and brokers). When
   * omitted, the ports registered with registerRunPorts() are used, minus
   * this run's own.
   */
  otherPorts?: number[];
}

export interface CliProfileInput extends ProfileInput {
  claudeBin: string;
  nodeBin: string;
  /** This run's broker port; null for a bid or review call, which has no broker (Task 9). */
  brokerPort: number | null;
  /**
   * The one directory the CLI may write besides tmp and the runtime paths.
   * Default `<runRoot>/repo`; a plan or review call's scratch root uses
   * `<runRoot>/work` (Task 9).
   */
  workDir?: string;
}

/** The Ollama port: only the engine talks to it. */
export const OLLAMA_PORT = 11434;

/**
 * The paths under his home the claude CLI must write while it runs
 * (relative to the home). The smoke run (Task 11) confirms this list.
 */
export const CLAUDE_RUNTIME_PATHS = ['.claude/debug', '.claude/todos', '.claude/telemetry'] as const;
// Never writable by a city run: his live sessions source `.claude/shell-snapshots`
// and `.claude/session-env`, read `.claude/statsig`, and start every `mcpServers`
// entry in `~/.claude.json`. City runs have no Bash tool, so they need none of
// them. Task 11's smoke run confirms that `claude -p` starts without writing
// `~/.claude.json`; if it cannot, the run gets a per-run CLAUDE_CONFIG_DIR copy,
// never a write to his own file.

/** Credential and config files under his home, denied by name in both profiles as a guard against a later edit. */
export const SECRET_PATHS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gh',
  '.netrc',
  '.npmrc',
  '.docker',
  '.gitconfig',
  '.git-credentials',
  '.config/git',
  'Library/Keychains',
] as const;

/** Claude's own configuration: never readable by a tool, never writable by the CLI. */
const CLAUDE_SECRET_PATHS = ['.claude', '.claude.json'] as const;

/** What the CLI may never write under ~/.claude. */
export const CLAUDE_WRITE_DENIED = [
  'settings.json',
  'settings.local.json',
  'CLAUDE.md',
  'skills',
  'plugins',
  'agents',
  'commands',
  'hooks',
  'projects',
  'shell-snapshots',
  'session-env',
  'statsig',
] as const;

/** Run root subdirectories the tool profile may read. */
const RUN_READ = ['repo', 'ship', 'base', 'tmp', 'home', 'cache', 'ctl'] as const;
/** Clones under the run root whose `.git` no sandboxed child may write. */
const RUN_CLONES = ['repo', 'ship', 'base'] as const;
/** Run root subdirectories the tool profile may write (the clones minus their .git). */
const RUN_WRITE = ['repo', 'ship', 'base', 'tmp', 'home', 'cache'] as const;

/** System locations every child may read and execute from. */
const BASE_SYSTEM_READ = ['/System', '/usr', '/bin', '/sbin', '/Library', '/opt/homebrew', '/private/etc', '/dev', '/private/var/db/dyld', '/private/var/db/timezone', '/private/var/select', '/private/var/db/xcode_select_link'];

/**
 * The active developer tools (git on a Mac is an xcrun shim that loads them):
 * the app bundle behind `xcode-select`'s link when it is outside /Library.
 */
function developerRoots(): string[] {
  for (const link of ['/private/var/select/developer_dir', '/private/var/db/xcode_select_link']) {
    try {
      const dev = realpathSync.native(link);
      const app = dev.match(/^(.*?\.app)\//);
      const root = app ? app[1] : dev;
      return BASE_SYSTEM_READ.some((b) => root === b || root.startsWith(b + '/')) ? [] : [root];
    } catch {
      // try the next link
    }
  }
  return [];
}

const SYSTEM_READ = [...BASE_SYSTEM_READ, ...developerRoots()];

/** Binaries no tool child may execute. `gh` is matched by regex wherever it lives. */
const TOOL_EXEC_DENIED = ['/usr/bin/security', '/usr/bin/osascript', '/usr/bin/sudo', '/bin/launchctl', '/usr/bin/open'];

/**
 * Mach services a tool child may look up: name resolution through
 * opendirectory (getpwuid), notifications, logging, preferences and the
 * system configuration. The keychain (SecurityServer, securityd), launch
 * services (`open` by another name) and the pasteboard are not on it.
 */
const TOOL_MACH = [
  'com.apple.system.opendirectoryd.libinfo',
  'com.apple.system.opendirectoryd.membership',
  'com.apple.system.notification_center',
  'com.apple.system.logger',
  'com.apple.logd',
  'com.apple.diagnosticd',
  'com.apple.cfprefsd.daemon',
  'com.apple.cfprefsd.agent',
  'com.apple.SystemConfiguration.configd',
  'com.apple.SystemConfiguration.DNSConfiguration',
  'com.apple.trustd',
  'com.apple.trustd.agent',
];

/** The keychain's mach services: denied to every tool child, whatever binary asks. */
export const KEYCHAIN_MACH = ['com.apple.SecurityServer', 'com.apple.securityd'] as const;

/* ------------------------------------------------------------------ */
/* Live run ports                                                      */
/* ------------------------------------------------------------------ */

const livePorts = new Map<string, Set<number>>();

/** Records a loopback port a run is serving on (its proxy, its broker), so profiles written for other runs deny it. */
export function registerRunPorts(runId: string, ports: number[]): void {
  const set = livePorts.get(runId) ?? new Set<number>();
  for (const p of ports) set.add(p);
  livePorts.set(runId, set);
}

/** Forgets a run's port (when its proxy or broker closes), or every port of the run. */
export function unregisterRunPorts(runId: string, ports?: number[]): void {
  const set = livePorts.get(runId);
  if (!set) return;
  if (ports) for (const p of ports) set.delete(p);
  if (!ports || set.size === 0) livePorts.delete(runId);
}

/** Every port registered by live runs, optionally excluding one run. */
export function liveRunPorts(exceptRunId?: string): number[] {
  const out: number[] = [];
  for (const [id, set] of livePorts) if (id !== exceptRunId) out.push(...set);
  return out.sort((a, b) => a - b);
}

/* ------------------------------------------------------------------ */
/* Profile text                                                        */
/* ------------------------------------------------------------------ */

/** The real path of `p`, resolving symlinks through its deepest existing ancestor (Seatbelt matches resolved paths: /tmp is /private/tmp). */
export function realish(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(realish(parent), basename(abs));
  }
}

function q(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function sub(p: string): string {
  return `(subpath ${q(p)})`;
}

function lit(p: string): string {
  return `(literal ${q(p)})`;
}

function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function rx(pattern: string): string {
  return `(regex #"${pattern.replace(/"/g, '\\"')}")`;
}

/** Every ancestor of `p` (excluding `p`), deepest last. */
function ancestors(p: string): string[] {
  const out: string[] = [];
  let cur = dirname(p);
  while (true) {
    out.unshift(cur);
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}

function ports(o: ProfileInput, runIdHint?: string): number[] {
  const broker = 'brokerPort' in o ? (o as CliProfileInput).brokerPort : null;
  const own = new Set<number>([o.proxyPort, ...(broker === null || broker === undefined ? [] : [broker])]);
  const others = o.otherPorts ?? liveRunPorts(runIdHint);
  return [...new Set(others)].filter((p) => !own.has(p)).sort((a, b) => a - b);
}

interface Resolved {
  runRoot: string;
  home: string;
  dataHome: string;
  toolchains: string[];
}

function resolveInput(o: ProfileInput): Resolved {
  return {
    runRoot: realish(o.runRoot),
    home: realish(o.home),
    dataHome: realish(o.dataHome),
    toolchains: o.toolchains.map(realish),
  };
}

function header(kind: string, r: Resolved): string[] {
  return [
    '(version 1)',
    `; Palimpsest ${kind} profile for ${r.runRoot}`,
    '(deny default)',
    '',
    '; processes',
    '(allow process-fork)',
    '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))',
    '(allow sysctl-read)',
    '(allow ipc-posix-sem)',
    '(allow ipc-posix-shm-read* ipc-posix-shm-write-data ipc-posix-shm-write-create)',
    '(allow file-ioctl (subpath "/dev"))',
    '(allow pseudo-tty)',
    '',
  ];
}

/** Read rules shared by both profiles: system, toolchains, the home deny, then the run root allows after it. */
function readRules(r: Resolved): string[] {
  const lines: string[] = [];
  lines.push('; reads: the system and the toolchains');
  lines.push('(allow file-read-metadata)');
  lines.push(`(allow file-read* (literal "/") ${SYSTEM_READ.map(sub).join(' ')})`);
  if (r.toolchains.length) lines.push(`(allow file-read* ${r.toolchains.map(sub).join(' ')})`);
  lines.push('');
  lines.push('; his home (which holds the data home) is unreadable');
  lines.push(`(deny file-read* ${sub(r.home)})`);
  if (!r.dataHome.startsWith(r.home + '/')) lines.push(`(deny file-read* ${sub(r.dataHome)})`);
  lines.push('');
  lines.push('; the run root, allowed after the home deny (the later rule wins)');
  lines.push(`(allow file-read* ${RUN_READ.map((d) => sub(join(r.runRoot, d))).join(' ')})`);
  lines.push(`(allow file-read* ${lit(r.runRoot)})`);
  // Toolchains under the home are read-allowed again after the home deny.
  if (r.toolchains.length) lines.push(`(allow file-read* ${r.toolchains.map(sub).join(' ')})`);
  // Path resolution (realpath, getcwd) stats every ancestor of the run root and the toolchains.
  const anc = new Set<string>();
  for (const p of [r.runRoot, ...r.toolchains]) for (const a of ancestors(p)) anc.add(a);
  lines.push(`(allow file-read-metadata ${[...anc].map(lit).join(' ')})`);
  lines.push('');
  return lines;
}

function secretDenies(r: Resolved, names: readonly string[]): string[] {
  return [
    '; credentials and config, denied by name after every allow',
    `(deny file-read* file-write* ${names.map((n) => sub(join(r.home, n))).join(' ')})`,
    '',
  ];
}

/**
 * Denies writes to each clone's `.git` and to the clone directory itself
 * (its literal path), so a clone can be neither renamed away, nor replaced
 * by another directory or a symlink with a `.git` of the agent's making.
 */
function cloneGitDenies(r: Resolved, clones: readonly string[]): string {
  return `(deny file-write* ${clones.map((c) => `${lit(join(r.runRoot, c))} ${sub(join(r.runRoot, c, '.git'))}`).join(' ')})`;
}

function devWrites(): string[] {
  return [
    '(allow file-write-data file-write-mode (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/ttys[0-9]+$"))',
  ];
}

/** The tool profile (ruling 9): every command an agent runs, installs and checks. */
export function toolProfile(o: ProfileInput): string {
  const r = resolveInput(o);
  const denyPorts = [o.enginePort, OLLAMA_PORT, ...ports(o)];
  const lines = header('tool', r);

  lines.push('; exec: the system, the toolchains and the run root, minus the binaries that reach his accounts');
  lines.push(`(allow process-exec ${SYSTEM_READ.map(sub).join(' ')} ${r.toolchains.map(sub).join(' ')} ${sub(r.runRoot)})`);
  lines.push(`(deny process-exec ${TOOL_EXEC_DENIED.map(lit).join(' ')} ${rx('/gh$')} ${rx('/claude$')})`);
  lines.push('');

  lines.push(...readRules(r));

  lines.push('; writes: the clones, tmp, the fake home and the caches; ctl stays read-only');
  lines.push(`(allow file-write* ${RUN_WRITE.map((d) => sub(join(r.runRoot, d))).join(' ')})`);
  lines.push(...devWrites());
  lines.push("; no clone's .git is writable, after the allow");
  lines.push(cloneGitDenies(r, RUN_CLONES));
  lines.push(`(deny file-write* ${sub(join(r.runRoot, 'ctl'))})`);
  lines.push('');

  lines.push(...secretDenies(r, [...SECRET_PATHS, ...CLAUDE_SECRET_PATHS]));

  lines.push('; mach: no keychain, no launch services');
  lines.push(`(allow mach-lookup ${TOOL_MACH.map((n) => `(global-name ${q(n)})`).join(' ')})`);
  lines.push(`(deny mach-lookup ${KEYCHAIN_MACH.map((n) => `(global-name ${q(n)})`).join(' ')})`);
  lines.push('');

  lines.push('; network: loopback only (the egress proxy carries the rest), minus the reserved ports');
  lines.push('(allow network-bind (local ip "localhost:*"))');
  lines.push('(allow network-inbound (local ip "localhost:*"))');
  lines.push('(allow network-outbound (remote ip "localhost:*"))');
  lines.push(`(allow network* (local unix-socket ${sub(r.runRoot)}) (remote unix-socket ${sub(r.runRoot)}))`);
  lines.push(`(deny network-outbound ${denyPorts.map((p) => `(remote ip "localhost:${p}")`).join(' ')})`);
  lines.push('');
  return lines.join('\n');
}

/** The claude runtime paths under `home`, resolved. */
export function claudeRuntimePaths(home: string): string[] {
  return CLAUDE_RUNTIME_PATHS.map((p) => join(realish(home), p));
}

/** The CLI profile (ruling 9): the claude process only. */
export function cliProfile(o: CliProfileInput): string {
  const r = resolveInput(o);
  const claudeBin = realish(o.claudeBin);
  const nodeBin = realish(o.nodeBin);
  const runtime = claudeRuntimePaths(r.home);
  const claudeJson = join(r.home, '.claude.json');
  const claudeDir = join(r.home, '.claude');
  const work = realish(o.workDir ?? join(o.runRoot, 'repo'));
  const isRepo = work === join(r.runRoot, 'repo');
  const lines = header('cli', r);

  lines.push('; exec: only the claude binary, security (his login) and node (the hook and the broker client)');
  const execs = new Set([o.claudeBin, claudeBin, '/usr/bin/security', o.nodeBin, nodeBin].map((p) => resolve(p)));
  lines.push(`(allow process-exec ${[...execs].map(lit).join(' ')})`);
  lines.push('');

  lines.push(...readRules(r));
  lines.push('; the claude install, his claude login state and the runtime paths');
  lines.push(`(allow file-read* ${sub(dirname(claudeBin))} ${lit(o.claudeBin)} ${sub(dirname(nodeBin))} ${rx('^' + reEscape(claudeJson) + '[^/]*$')} ${runtime.map(sub).join(' ')})`);
  lines.push(`(allow file-read-metadata ${lit(claudeDir)})`);
  if (!isRepo) lines.push(`(allow file-read* ${sub(work)})`);
  lines.push('');

  lines.push(`; writes: the ${isRepo ? 'repo' : 'work dir'}, tmp and the runtime paths (never ~/.claude.json)`);
  lines.push(`(allow file-write* ${sub(work)} ${sub(join(r.runRoot, 'tmp'))} ${runtime.map(sub).join(' ')})`);
  lines.push(...devWrites());
  lines.push(isRepo ? cloneGitDenies(r, ['repo']) : `(deny file-write* ${lit(work)} ${sub(join(work, '.git'))})`);
  lines.push(`(deny file-write* ${sub(join(r.runRoot, 'ctl'))})`);
  lines.push('; his claude settings, memory, skills, plugins, agents, commands, hooks and transcripts');
  lines.push(`(deny file-write* ${rx('^' + reEscape(claudeDir) + '/settings[^/]*\\.json$')} ${rx('^' + reEscape(claudeJson) + '[^/]*$')} ${CLAUDE_WRITE_DENIED.map((n) => sub(join(claudeDir, n))).join(' ')})`);
  lines.push(`(deny file-read* ${sub(join(claudeDir, 'projects'))} ${lit(join(claudeDir, 'history.jsonl'))})`);
  lines.push('');

  lines.push(...secretDenies(r, SECRET_PATHS));

  lines.push('; mach: the keychain is needed by security for his login');
  lines.push(`(allow mach-lookup ${[...TOOL_MACH, ...KEYCHAIN_MACH].map((n) => `(global-name ${q(n)})`).join(' ')})`);
  lines.push('');

  lines.push(o.brokerPort === null ? "; network: only this call's proxy" : "; network: only this run's proxy and broker");
  const outbound = [o.proxyPort, ...(o.brokerPort === null ? [] : [o.brokerPort])];
  lines.push(`(allow network-outbound ${outbound.map((p) => `(remote ip "localhost:${p}")`).join(' ')})`);
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* wrap                                                                */
/* ------------------------------------------------------------------ */

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** True when children run unsandboxed: PALIMPSEST_SANDBOX=off, or not a Mac. */
export function sandboxOff(): boolean {
  return process.env.PALIMPSEST_SANDBOX === 'off' || process.platform !== 'darwin';
}

/**
 * Writes the profile for `kind` to `<runRoot>/ctl/<kind>.sb` and returns
 * the argv that runs `argv` under it. When the sandbox is off it returns
 * `argv` unchanged and logs `sandbox off`, but never on the real data home.
 */
export function wrap(argv: string[], kind: 'tool', o: ProfileInput, log?: (line: string) => void): string[];
export function wrap(argv: string[], kind: 'cli', o: CliProfileInput, log?: (line: string) => void): string[];
export function wrap(argv: string[], kind: 'tool' | 'cli', o: ProfileInput | CliProfileInput, log?: (line: string) => void): string[] {
  if (sandboxOff()) {
    if (isRealDataHome(dataHomeDir())) throw new Error('sandbox cannot be off on the real data home');
    (log ?? ((l: string) => console.warn(l)))('sandbox off');
    return argv;
  }
  const text = kind === 'tool' ? toolProfile(o) : cliProfile(o as CliProfileInput);
  const ctl = join(o.runRoot, 'ctl');
  mkdirSync(ctl, { recursive: true });
  const path = join(ctl, `${kind}.sb`);
  try {
    unlinkSync(path);
  } catch {
    // not there yet
  }
  writeFileSync(path, text, { mode: 0o444 });
  chmodSync(path, 0o444);
  return [SANDBOX_EXEC, '-f', path, ...argv];
}

/* ------------------------------------------------------------------ */
/* Toolchains and the child environment                                */
/* ------------------------------------------------------------------ */

/** Toolchain roots under `home` that exist (ruling 9), in a fixed order. */
export function detectToolchains(home: string = homedir()): string[] {
  return ['.nvm', '.cargo/bin', '.rustup', 'go/bin', '.pyenv', '.local/bin']
    .map((p) => join(home, p))
    .filter((p) => existsSync(p));
}

/** The bin directories to put on PATH for the detected toolchains. */
function toolchainBins(toolchains: string[]): string[] {
  const bins: string[] = [];
  for (const t of toolchains) {
    if (t.endsWith('/.nvm')) {
      const nodeDir = dirname(process.execPath);
      if (nodeDir.startsWith(t + '/')) {
        bins.push(nodeDir);
      } else {
        try {
          const versions = readdirSync(join(t, 'versions', 'node')).sort(compareVersions);
          const last = versions.at(-1);
          if (last) bins.push(join(t, 'versions', 'node', last, 'bin'));
        } catch {
          // no node versions installed
        }
      }
    } else if (t.endsWith('/.pyenv')) {
      bins.push(join(t, 'shims'), join(t, 'bin'));
    } else if (t.endsWith('/.rustup')) {
      // rustup's proxies live in ~/.cargo/bin
    } else {
      bins.push(t);
    }
  }
  return bins;
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The developer tools' own bin (git without the xcrun shim, which wants a cache outside the sandbox). */
function developerBins(): string[] {
  for (const link of ['/private/var/select/developer_dir', '/private/var/db/xcode_select_link']) {
    try {
      return [join(realpathSync.native(link), 'usr', 'bin')];
    } catch {
      // try the next link
    }
  }
  return [];
}

export const SYSTEM_PATH = ['/opt/homebrew/bin', '/usr/local/bin', ...developerBins(), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

export interface ChildEnvExtra {
  /** This run's egress proxy port. Default: read from `<ctl>/egress.json`; when unknown, a closed port so nothing leaks. */
  proxyPort?: number;
  /** This run's egress token. Default: read from `<ctl>/egress.token`. */
  proxyToken?: string;
  /** Toolchain roots. Default: detectToolchains(). */
  toolchains?: string[];
  /** Extra variables the caller names explicitly. */
  env?: Record<string, string>;
}

/** The URL a run's children use for their egress proxy, carrying the run's token. */
export function proxyUrl(port: number, token: string): string {
  return `http://palimpsest:${encodeURIComponent(token)}@127.0.0.1:${port}`;
}

function readCtl(runRoot: string, name: string): string | null {
  try {
    return readFileSync(join(runRoot, 'ctl', name), 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * The tool environment, built from nothing (ruling 8): a fake home, a run
 * tmp, per-run caches, an empty global git config, the egress proxy and
 * no variable from the engine's own environment.
 */
export function childEnv(runRoot: string, extra: ChildEnvExtra = {}): Record<string, string> {
  const root = realish(runRoot);
  const ctl = join(root, 'ctl');
  const cache = join(root, 'cache');
  const toolchains = extra.toolchains ?? detectToolchains();

  let port = extra.proxyPort;
  if (port === undefined) {
    const raw = readCtl(root, 'egress.json');
    try {
      port = raw ? (JSON.parse(raw) as { port: number }).port : undefined;
    } catch {
      port = undefined;
    }
  }
  const token = extra.proxyToken ?? readCtl(root, 'egress.token') ?? 'none';
  const proxy = proxyUrl(port ?? 9, token);

  const env: Record<string, string> = {
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp') + '/',
    PATH: [...toolchainBins(toolchains), ...SYSTEM_PATH].join(':'),
    LANG: 'en_US.UTF-8',
    GIT_CONFIG_GLOBAL: join(ctl, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: 'localhost,127.0.0.1',
    no_proxy: 'localhost,127.0.0.1',
    npm_config_cache: join(cache, 'npm'),
    npm_config_userconfig: join(ctl, 'npmrc'),
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: join(root, 'home', '.config'),
    PIP_CACHE_DIR: join(cache, 'pip'),
    CARGO_HOME: join(cache, 'cargo'),
    GOMODCACHE: join(cache, 'gomod'),
    GOCACHE: join(cache, 'go'),
    CI: '1',
  };
  const rustup = toolchains.find((t) => t.endsWith('/.rustup'));
  if (rustup) env.RUSTUP_HOME = rustup;
  const pyenv = toolchains.find((t) => t.endsWith('/.pyenv'));
  if (pyenv) env.PYENV_ROOT = pyenv;
  return { ...env, ...(extra.env ?? {}) };
}
