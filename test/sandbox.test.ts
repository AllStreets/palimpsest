import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { defaultHome } from '../engine/home.js';
import {
  CLAUDE_RUNTIME_PATHS,
  childEnv,
  cliProfile,
  selectedShell,
  registerRunPorts,
  toolProfile,
  unregisterRunPorts,
  wrap,
  type CliProfileInput,
  type ProfileInput,
} from '../engine/market/sandbox.js';

const HOME = '/Users/someone';
const DATA = `${HOME}/Library/Application Support/Palimpsest`;
const ROOT = `${DATA}/runs/run-1`;

const input: ProfileInput = {
  runRoot: ROOT,
  home: HOME,
  dataHome: DATA,
  enginePort: 4770,
  proxyPort: 50001,
  toolchains: [`${HOME}/.nvm`, `${HOME}/.cargo/bin`],
  otherPorts: [50101, 50102],
};
const cliInput: CliProfileInput = {
  ...input,
  claudeBin: '/opt/homebrew/Caskroom/claude-code/2.1.319/claude',
  nodeBin: `${HOME}/.nvm/versions/node/v22.23.0/bin/node`,
  brokerPort: 50002,
};

let previousEnv: Record<string, string | undefined>;
const ENV_KEYS = ['PALIMPSEST_HOME', 'PALIMPSEST_SANDBOX', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK'];

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (previousEnv[k] === undefined) delete process.env[k];
    else process.env[k] = previousEnv[k];
  }
});

function at(text: string, needle: string): number {
  const i = text.indexOf(needle);
  assert.ok(i >= 0, `profile lacks: ${needle}`);
  return i;
}

/** The index of the last line that contains every needle. */
function lineAt(text: string, ...needles: string[]): number {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) if (needles.every((n) => lines[i].includes(n))) return i;
  assert.fail(`no line with ${needles.join(' and ')}`);
}

describe('profile text', () => {
  test('tool profile denies by default', () => {
    const p = toolProfile(input);
    assert.ok(p.startsWith('(version 1)'));
    assert.ok(at(p, '(deny default)') < at(p, '(allow '));
  });

  test('the run root read allow comes after the home read deny', () => {
    const p = toolProfile(input);
    const deny = lineAt(p, '(deny file-read*', `(subpath "${HOME}")`);
    const allow = lineAt(p, '(allow file-read*', `(subpath "${ROOT}/repo")`);
    assert.ok(deny < allow);
    for (const d of ['repo', 'ship', 'base', 'tmp', 'home', 'cache', 'ctl']) {
      assert.ok(lineAt(p, '(allow file-read*', `(subpath "${ROOT}/${d}")`) > deny, d);
    }
  });

  test('tool profile denies reads of gh config, netrc, npmrc, docker, ssh, aws, claude and keychains by name', () => {
    const p = toolProfile(input);
    const lastAllow = lineAt(p, '(allow file-read*');
    for (const name of ['.config/gh', '.netrc', '.npmrc', '.docker', '.ssh', '.aws', '.gnupg', '.gitconfig', '.claude', '.claude.json', 'Library/Keychains']) {
      const i = lineAt(p, '(deny file-read*', `(subpath "${HOME}/${name}")`);
      assert.ok(i > lastAllow, `${name} deny must follow every read allow`);
    }
  });

  test('ctmp is the CLI profile\'s alone: written by the CLI profile, denied by name in the tool profile', () => {
    const t = toolProfile(input);
    assert.ok(lineAt(t, '(deny file-read* file-write*', `(subpath "${ROOT}/ctmp")`) > lineAt(t, '(allow file-write*'));
    assert.ok(!/\(allow file-[^\n]*\/ctmp"/.test(t));
    const c = cliProfile(cliInput);
    assert.ok(lineAt(c, '(allow file-write*', `(subpath "${ROOT}/ctmp")`) >= 0);
    assert.ok(lineAt(c, '(allow file-read*', `(subpath "${ROOT}/ctmp")`) >= 0);
  });

  test("tool profile denies writes under the repo's .git", () => {
    const p = toolProfile(input);
    const allow = lineAt(p, '(allow file-write*', `(subpath "${ROOT}/repo")`);
    const deny = lineAt(p, '(deny file-write*', `(subpath "${ROOT}/repo/.git")`);
    assert.ok(allow < deny);
    assert.ok(lineAt(p, '(deny file-write*', `(subpath "${ROOT}/ctl")`) > allow);
    assert.ok(!/\(allow file-write\*[^\n]*\/ctl"/.test(p), 'ctl is never writable');
  });

  test('tool profile denies exec of security, gh, osascript, sudo, launchctl and open', () => {
    const p = toolProfile(input);
    const allow = lineAt(p, '(allow process-exec');
    const deny = lineAt(p, '(deny process-exec');
    assert.ok(allow < deny);
    const line = p.split('\n')[deny];
    for (const bin of ['/usr/bin/security', '/usr/bin/osascript', '/usr/bin/sudo', '/bin/launchctl', '/usr/bin/open']) {
      assert.ok(line.includes(`(literal "${bin}")`), bin);
    }
    assert.ok(line.includes('(regex #"/gh$")'));
  });

  test("tool profile denies the engine port, 11434 and other live runs' proxy and broker ports after the loopback allow", () => {
    const p = toolProfile(input);
    const allow = lineAt(p, '(allow network-outbound', '(remote ip "localhost:*")');
    for (const port of [4770, 11434, 50101, 50102]) {
      assert.ok(lineAt(p, '(deny network-outbound', `(remote ip "localhost:${port}")`) > allow, String(port));
    }
    assert.ok(!p.includes('localhost:50001")') || !/deny network-outbound[^\n]*localhost:50001"/.test(p), "this run's own proxy stays reachable");
    assert.ok(!/allow network-outbound[^\n]*\(remote ip "\*:/.test(p), 'no remote host but loopback');
  });

  test('tool profile takes other live runs from the registry when not given', () => {
    registerRunPorts('other-run', [50201, 50202]);
    registerRunPorts('this-run', [50001]);
    try {
      const { otherPorts: _omit, ...rest } = input;
      const p = toolProfile(rest);
      assert.ok(/deny network-outbound[^\n]*localhost:50201"[^\n]*localhost:50202"/.test(p));
      assert.ok(!/deny network-outbound[^\n]*localhost:50001"/.test(p));
    } finally {
      unregisterRunPorts('other-run');
      unregisterRunPorts('this-run');
    }
  });

  test('tool profile denies writes to the clone directories themselves, so they cannot be renamed or replaced', () => {
    const p = toolProfile(input);
    const allow = lineAt(p, '(allow file-write*', `(subpath "${ROOT}/repo")`);
    for (const c of ['repo', 'ship', 'base']) {
      assert.ok(lineAt(p, '(deny file-write*', `(literal "${ROOT}/${c}")`) > allow, c);
    }
    const cli = cliProfile(cliInput);
    assert.ok(lineAt(cli, '(deny file-write*', `(literal "${ROOT}/repo")`) > lineAt(cli, '(allow file-write*', `(subpath "${ROOT}/repo")`));
  });

  test('tool profile allows reads and writes of ship and base and denies their .git', () => {
    // The base checkout is its own side (Task 15): the head profile writes ship, the base profile writes base.
    for (const [c, side] of [['ship', 'head'], ['base', 'base']] as const) {
      const p = toolProfile({ ...input, side });
      const allowW = lineAt(p, '(allow file-write*', `(subpath "${ROOT}/${c}")`);
      assert.ok(allowW >= 0);
      assert.ok(lineAt(p, '(allow file-read*', `(subpath "${ROOT}/${c}")`) >= 0);
      assert.ok(lineAt(p, '(deny file-write*', `(subpath "${ROOT}/${c}/.git")`) > allowW);
    }
    assert.ok(!toolProfile(input).split('\n').some((l) => l.startsWith('(allow file-write*') && l.includes(`(subpath "${ROOT}/base")`)), 'the head side never writes the base clone');
  });

  test('tool profile denies mach-lookup of the security server', () => {
    const p = toolProfile(input);
    const allow = lineAt(p, '(allow mach-lookup');
    const deny = lineAt(p, '(deny mach-lookup', '(global-name "com.apple.SecurityServer")', '(global-name "com.apple.securityd")');
    assert.ok(deny > allow);
    assert.ok(!p.split('\n')[allow].includes('SecurityServer'));
    assert.ok(!p.split('\n')[allow].includes('launchservices'));
  });

  test("cli profile denies every loopback port but this run's proxy and broker", () => {
    const p = cliProfile(cliInput);
    const outbound = p.split('\n').filter((l) => l.includes('network-outbound'));
    assert.deepEqual(outbound, ['(allow network-outbound (remote ip "localhost:50001") (remote ip "localhost:50002"))']);
    assert.ok(!p.includes('localhost:*'));
    assert.ok(!p.includes('network-bind'));
  });

  test('cli profile allows exec of only the claude binary, security, node, /bin/sh and the shell it selects', () => {
    const p = cliProfile(cliInput);
    const execs = p.split('\n').filter((l) => l.includes('process-exec'));
    assert.equal(execs.length, 1);
    const allowed = [...execs[0].matchAll(/\(literal "([^"]+)"\)/g)].map((m) => m[1]).sort();
    const shells = ['/bin/sh', ...(selectedShell() ? [selectedShell() as string] : [])];
    assert.deepEqual(allowed, [...new Set([cliInput.claudeBin, cliInput.nodeBin, '/usr/bin/security', ...shells])].sort());
    assert.ok(!allowed.includes('/bin/zsh') || selectedShell() === '/bin/zsh');
    assert.ok(p.includes('(allow file-read* (literal "/private/var/select/sh"))'));
    assert.ok(!/process-exec[^\n]*subpath/.test(p));
  });

  test('cli profile allows writes to claude runtime paths and denies settings, CLAUDE.md, skills, plugins, agents, commands, hooks and projects', () => {
    const p = cliProfile(cliInput);
    const allow = lineAt(p, '(allow file-write*', `(subpath "${ROOT}/repo")`);
    const line = p.split('\n')[allow];
    for (const rel of CLAUDE_RUNTIME_PATHS) assert.ok(line.includes(`(subpath "${HOME}/${rel}")`), rel);
    // His live sessions source shell snapshots and session env, read statsig, and run mcpServers from ~/.claude.json.
    for (const rel of ['.claude/shell-snapshots', '.claude/session-env', '.claude/statsig']) {
      assert.ok(!(CLAUDE_RUNTIME_PATHS as readonly string[]).includes(rel), rel);
      assert.ok(!line.includes(`${HOME}/${rel}`), rel);
    }
    assert.ok(!line.includes('claude\\.json'), 'never ~/.claude.json');
    assert.ok(!line.includes(`(subpath "${HOME}/.claude")`), 'never the whole of ~/.claude');
    const deny = lineAt(p, '(deny file-write*', 'settings[^/]*\\.json$');
    assert.ok(deny > allow);
    for (const name of ['CLAUDE.md', 'skills', 'plugins', 'agents', 'commands', 'hooks', 'projects', 'shell-snapshots', 'session-env', 'statsig']) {
      assert.ok(p.split('\n')[deny].includes(`(subpath "${HOME}/.claude/${name}")`), name);
    }
    assert.ok(p.split('\n')[deny].includes('\\.claude\\.json[^/]*$'), '~/.claude.json and its siblings are write-denied');
    const readDeny = lineAt(p, '(deny file-read*', `(subpath "${HOME}/.claude/projects")`);
    assert.ok(p.split('\n')[readDeny].includes(`(literal "${HOME}/.claude/history.jsonl")`));
    assert.ok(readDeny > lineAt(p, '(allow file-read*'));
    assert.ok(lineAt(p, '(deny file-write*', `(subpath "${ROOT}/repo/.git")`) > allow);
    assert.ok(lineAt(p, '(deny file-read*', `(subpath "${HOME}/.config/gh")`) > lineAt(p, '(allow file-read*'));
  });
});

describe('the claude login under the cli profile (Task 11)', () => {
  test('cli profile lets security read his login keychain and its preferences, read-only; the tool profile never', () => {
    const p = cliProfile(cliInput);
    const lines = p.split('\n');
    const homeDeny = lineAt(p, '(deny file-read*', `(subpath "${HOME}")`);
    const allow = lineAt(p, '(allow file-read*', `(subpath "${HOME}/Library/Keychains")`, '(subpath "/private/var/db/mds")', `(literal "${HOME}/Library/Preferences/com.apple.security.plist")`);
    assert.ok(allow > homeDeny, 'the keychain read comes after the home deny');
    for (const [i, l] of lines.entries()) {
      if (l.includes('Library/Keychains') && l.startsWith('(deny file-read*')) assert.ok(i < allow, 'no read deny of the keychains follows the allow');
      if (l.includes('Library/Keychains') && l.startsWith('(allow file-write')) assert.fail('the keychains are never writable');
    }
    assert.ok(lineAt(p, '(deny file-write*', `(subpath "${HOME}/Library/Keychains")`) > allow, 'keychain writes are denied by name');
    assert.ok(p.includes('(allow user-preference-read (preference-domain "kCFPreferencesAnyApplication") (preference-domain "com.apple.security"))'));
    const t = toolProfile(input);
    assert.ok(!t.includes('user-preference-read'));
    assert.ok(!t.includes('/private/var/db/mds'));
    assert.ok(lineAt(t, '(deny file-read*', `(subpath "${HOME}/Library/Keychains")`) > lineAt(t, '(allow file-read*'));
  });
});

describe('wrap and the child environment', () => {
  test('wrap is identity when sandbox is off on a temp home', () => {
    const dir = mkdtempSync(join(tmpdir(), 'palimpsest-sandbox-test-'));
    try {
      process.env.PALIMPSEST_HOME = dir;
      process.env.PALIMPSEST_SANDBOX = 'off';
      const logged: string[] = [];
      const argv = ['/bin/sh', '-c', 'true'];
      assert.deepEqual(wrap(argv, 'tool', { ...input, runRoot: join(dir, 'runs', 'r') }, (l) => logged.push(l)), argv);
      assert.deepEqual(logged, ['sandbox off']);
      assert.ok(!existsSync(join(dir, 'runs', 'r', 'ctl', 'tool.sb')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('wrap throws when sandbox is off on the real home', () => {
    process.env.PALIMPSEST_HOME = defaultHome();
    process.env.PALIMPSEST_SANDBOX = 'off';
    assert.throws(() => wrap(['/bin/true'], 'tool', input, () => {}), /sandbox cannot be off on the real data home/);
    delete process.env.PALIMPSEST_HOME;
    assert.throws(() => wrap(['/bin/true'], 'tool', input, () => {}), /sandbox cannot be off on the real data home/);
  });

  test('wrap writes the profile to ctl and runs it through sandbox-exec', { skip: process.platform !== 'darwin' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'palimpsest-sandbox-test-'));
    try {
      process.env.PALIMPSEST_HOME = dir;
      delete process.env.PALIMPSEST_SANDBOX;
      const runRoot = join(dir, 'runs', 'r');
      const argv = wrap(['/bin/echo', 'hi'], 'tool', { ...input, runRoot, home: dir, dataHome: dir });
      assert.deepEqual(argv, ['/usr/bin/sandbox-exec', '-f', join(runRoot, 'ctl', 'tool.sb'), '/bin/echo', 'hi']);
      assert.match(readFileSync(join(runRoot, 'ctl', 'tool.sb'), 'utf8'), /^\(version 1\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('childEnv carries no variable from the parent', () => {
    process.env.GH_TOKEN = 'gh-secret-value';
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-value';
    process.env.GITHUB_TOKEN = 'ghp-secret-value';
    process.env.SSH_AUTH_SOCK = '/private/tmp/agent.sock';
    const root = '/private/tmp/palimpsest-run-root';
    const env = childEnv(root, { proxyPort: 50001, proxyToken: 'tok', toolchains: [] });
    for (const k of ['GH_TOKEN', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'SSH_AUTH_SOCK', 'USER', 'LOGNAME', 'SHELL', 'PALIMPSEST_HOME', 'NODE_OPTIONS']) {
      assert.ok(!(k in env), k);
    }
    for (const v of Object.values(env)) assert.ok(!/secret-value|agent\.sock/.test(v));
    assert.equal(env.HOME, `${root}/home`);
    assert.equal(env.TMPDIR, `${root}/tmp/`);
    assert.equal(env.GIT_CONFIG_GLOBAL, `${root}/ctl/gitconfig`);
    assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
    assert.equal(env.GIT_TERMINAL_PROMPT, '0');
    assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) assert.equal(env[k], 'http://palimpsest:tok@127.0.0.1:50001', k);
    assert.equal(env.NO_PROXY, 'localhost,127.0.0.1');
    assert.equal(env.npm_config_userconfig, `${root}/ctl/npmrc`);
    assert.equal(env.XDG_CONFIG_HOME, `${root}/home/.config`);
    for (const k of ['npm_config_cache', 'XDG_CACHE_HOME', 'PIP_CACHE_DIR', 'CARGO_HOME', 'GOMODCACHE', 'GOCACHE']) {
      assert.ok(env[k].startsWith(`${root}/cache`), `${k} is per run`);
    }
    assert.equal(env.CI, '1');
    assert.ok(env.PATH.split(':').includes('/usr/bin'));
  });

  test('childEnv points the proxy at a closed port when the run has none', () => {
    const env = childEnv('/private/tmp/palimpsest-no-proxy', { toolchains: [] });
    assert.match(env.HTTPS_PROXY, /@127\.0\.0\.1:9$/);
  });
});

/* ------------------------------------------------------------------ */
/* Execution: real sandbox-exec, harmless commands, temp dirs only.    */
/* ------------------------------------------------------------------ */

const hasSandbox = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
const PYTHON = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find((p) => existsSync(p));

function run(argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env ?? { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }));
  });
}

describe('execution under sandbox-exec', { skip: !hasSandbox && 'sandbox-exec is not available' }, () => {
  let t: string;
  let home: string;
  let data: string;
  let runRoot: string;
  let o: ProfileInput;
  const servers: Server[] = [];

  async function listen(): Promise<number> {
    const s = createServer((_q, r) => r.end('reached'));
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    return (s.address() as { port: number }).port;
  }

  beforeEach(() => {
    t = realpathSync(mkdtempSync(join(tmpdir(), 'palimpsest-sbx-')));
    // A temp home standing in for his, with the data home inside it as on his Mac.
    home = join(t, 'home');
    data = join(home, 'Library', 'Application Support', 'Palimpsest');
    runRoot = join(data, 'runs', 'run-1');
    for (const d of ['repo/.git/hooks', 'tmp', 'ctmp', 'home', 'cache', 'ctl', 'ship/.git', 'base/.git']) mkdirSync(join(runRoot, d), { recursive: true });
    writeFileSync(join(runRoot, 'repo', 'file.txt'), 'inside\n');
    writeFileSync(join(runRoot, 'repo', '.git', 'config'), '[core]\n');
    writeFileSync(join(runRoot, 'ctl', 'gitconfig'), '');
    mkdirSync(join(home, '.config', 'gh'), { recursive: true });
    writeFileSync(join(home, '.config', 'gh', 'hosts.yml'), 'oauth_token: stand-in\n');
    writeFileSync(join(home, 'outside.txt'), 'outside\n');
    for (const d of ['debug', 'todos', 'shell-snapshots', 'session-env', 'statsig']) mkdirSync(join(home, '.claude', d), { recursive: true });
    writeFileSync(join(home, '.claude', 'shell-snapshots', 'snapshot-zsh-1.sh'), '# his\n');
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{}\n');
    writeFileSync(join(home, '.claude', 'projects', 'p.jsonl'), 'transcript\n');
    writeFileSync(join(home, '.claude.json'), '{}\n');
    process.env.PALIMPSEST_HOME = data;
    delete process.env.PALIMPSEST_SANDBOX;
    o = { runRoot, home, dataHome: data, enginePort: 9, proxyPort: 9, toolchains: [], otherPorts: [] };
  });

  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
    rmSync(t, { recursive: true, force: true });
  });

  function tool(cmd: string, over: Partial<ProfileInput> = {}) {
    const argv = wrap(['/bin/sh', '-c', cmd], 'tool', { ...o, ...over });
    return run(argv, { cwd: join(runRoot, 'repo'), env: childEnv(runRoot, { proxyPort: o.proxyPort, proxyToken: 't', toolchains: [] }) });
  }

  test('a write outside the run root fails', async () => {
    const r = await tool(`echo x > '${home}/new.txt'; echo x > '${t}/new.txt'; echo x > '${data}/new.txt'; echo x > '${runRoot}/new.txt'; echo x > '${runRoot}/ctl/gitconfig'`);
    assert.match(r.stderr, /Operation not permitted/);
    for (const p of [join(home, 'new.txt'), join(t, 'new.txt'), join(data, 'new.txt'), join(runRoot, 'new.txt')]) assert.ok(!existsSync(p), p);
    assert.equal(readFileSync(join(runRoot, 'ctl', 'gitconfig'), 'utf8'), '');
    const ok = await tool(`echo y > '${runRoot}/repo/y.txt' && echo z > '${runRoot}/tmp/z' && echo w > '${runRoot}/cache/w'`);
    assert.equal(ok.code, 0, ok.stderr);
  });

  test("claude's own temp dir (ctmp) is neither writable nor readable by a tool child (Task 11 minors)", async () => {
    writeFileSync(join(runRoot, 'ctmp', 'claude-state'), 'claude\n');
    const r = await tool(`echo x > '${runRoot}/ctmp/planted'; cat '${runRoot}/ctmp/claude-state'`);
    assert.match(r.stderr, /Operation not permitted/);
    assert.ok(!existsSync(join(runRoot, 'ctmp', 'planted')));
    assert.ok(!r.stdout.includes('claude'));
  });

  test('a read of a file under the run root succeeds although the home is denied', async () => {
    const r = await tool(`/bin/cat '${runRoot}/repo/file.txt'`);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, 'inside\n');
  });

  test('a read of a file in the temp home outside the run root fails', async () => {
    for (const p of [join(home, 'outside.txt'), join(home, '.config', 'gh', 'hosts.yml'), join(home, '.claude', 'settings.json'), join(home, '.claude.json')]) {
      const r = await tool(`/bin/cat '${p}'`);
      assert.notEqual(r.code, 0, p);
      assert.equal(r.stdout, '');
    }
    const ls = await tool(`/bin/ls '${home}'`);
    assert.notEqual(ls.code, 0);
  });

  test('a symlink or a hardlink in the repo does not reach a denied file', async () => {
    symlinkSync(join(home, '.config', 'gh', 'hosts.yml'), join(runRoot, 'repo', 'planted-link'));
    const r = await tool(`/bin/cat planted-link; /bin/ln '${home}/.config/gh/hosts.yml' hard; /bin/cat hard`);
    assert.doesNotMatch(r.stdout, /stand-in/);
    assert.ok(!existsSync(join(runRoot, 'repo', 'hard')));
  });

  test('a write to repo/.git/config fails', async () => {
    const r = await tool(`echo '[core] fsmonitor = /tmp/x' >> .git/config; echo hook > .git/hooks/pre-commit; /bin/ln .git/config cfg-link; /bin/mv .git moved; /bin/rm -rf .git`);
    assert.match(r.stderr, /Operation not permitted/);
    assert.equal(readFileSync(join(runRoot, 'repo', '.git', 'config'), 'utf8'), '[core]\n');
    assert.ok(!existsSync(join(runRoot, 'repo', '.git', 'hooks', 'pre-commit')));
    assert.ok(!existsSync(join(runRoot, 'repo', 'cfg-link')));
    assert.ok(!existsSync(join(runRoot, 'repo', 'moved')));
    const ship = await tool(`echo x > '${runRoot}/ship/.git/config'; echo x > '${runRoot}/base/.git/config'`);
    assert.match(ship.stderr, /Operation not permitted/);
    assert.ok(!existsSync(join(runRoot, 'ship', '.git', 'config')));
  });

  test('exec of /usr/bin/security fails', async () => {
    const r = await tool('/usr/bin/security list-keychains');
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.stdout, /keychain/i);
  });

  test('exec of anything named gh fails', async () => {
    const fake = join(runRoot, 'tmp', 'gh');
    writeFileSync(fake, '#!/bin/sh\necho ran\n');
    chmodSync(fake, 0o755);
    assert.equal((await run([fake])).stdout, 'ran\n', 'the stand-in runs outside the sandbox');
    const r = await tool(`'${fake}'`);
    assert.notEqual(r.code, 0);
    assert.doesNotMatch(r.stdout, /ran/);
  });

  test('a renamed copy of security cannot reach the keychain', async (ctx) => {
    const sec = join(runRoot, 'tmp', 'sec');
    copyFileSync('/usr/bin/security', sec);
    chmodSync(sec, 0o755);
    const outside = await run([sec, 'list-keychains']);
    if (outside.code !== 0 || !/keychain/i.test(outside.stdout)) {
      ctx.skip('the copy does not list keychains outside the sandbox');
      return;
    }
    const inside = await tool(`'${sec}' list-keychains`);
    assert.doesNotMatch(inside.stdout, /keychain/i);
  });

  test("no tool child can look up the keychain's mach service, whatever binary asks", { skip: !PYTHON && 'no python3 outside the developer tools' }, async (ctx) => {
    const python = PYTHON as string;
    const script = join(runRoot, 'tmp', 'lookup.py');
    writeFileSync(
      script,
      [
        'import ctypes, sys',
        "libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib')",
        "bp = ctypes.c_uint.in_dll(libc, 'bootstrap_port')",
        'port = ctypes.c_uint(0)',
        'for name in sys.argv[1:]:',
        '    print(name, libc.bootstrap_look_up(bp, name.encode(), ctypes.byref(port)))',
      ].join('\n'),
    );
    const outside = await run([python, script, 'com.apple.SecurityServer']);
    if (outside.stdout.trim() !== 'com.apple.SecurityServer 0') {
      ctx.skip('the lookup does not succeed outside the sandbox');
      return;
    }
    const inside = await tool(`'${python}' '${script}' com.apple.SecurityServer com.apple.logd`);
    assert.match(inside.stdout, /^com\.apple\.SecurityServer [1-9]\d*$/m, inside.stdout + inside.stderr);
    assert.match(inside.stdout, /^com\.apple\.logd 0$/m, 'the probe itself works inside');
  });

  test('the repo, ship and base cannot be renamed, replaced or swapped for a symlink', async () => {
    writeFileSync(join(runRoot, 'ship', 'f'), 's\n');
    const r = await tool(
      `cd '${runRoot}' && /bin/mv repo tmp/x; /bin/mv ship tmp/s; /bin/mv base tmp/b; /bin/rm -rf repo; /bin/ln -s '${home}' tmp/l && /bin/mv tmp/l repo; ` +
        `/bin/mkdir -p tmp/x/.git && echo '${home}' > tmp/x/.git/commondir && /bin/mv tmp/x repo; echo done`,
    );
    assert.match(r.stdout, /done/);
    for (const c of ['repo', 'ship', 'base']) {
      const st = lstatSync(join(runRoot, c));
      assert.ok(st.isDirectory() && !st.isSymbolicLink(), c);
    }
    // rm -rf may empty the worktree (that is ordinary work) but never the .git or the directory itself.
    assert.equal(readFileSync(join(runRoot, 'repo', '.git', 'config'), 'utf8'), '[core]\n');
    assert.ok(!existsSync(join(runRoot, 'repo', '.git', 'commondir')));
    assert.ok(!existsSync(join(runRoot, 'tmp', 'x')));
    // Work inside the clones still goes on.
    const ok = await tool(`echo y > '${runRoot}/repo/sub.txt' && /bin/mkdir -p '${runRoot}/repo/src/a' && /bin/mv '${runRoot}/repo/sub.txt' '${runRoot}/repo/src/a/sub.txt'`);
    assert.equal(ok.code, 0, ok.stderr);
  });

  test('the engine port is unreachable as 0.0.0.0, ::1, ::ffff:127.0.0.1 and localhost', async () => {
    const engine = await listen();
    const s6 = createServer((_q, r) => r.end('reached'));
    servers.push(s6);
    await new Promise<void>((r) => s6.listen(engine, '::1', () => r()));
    for (const host of ['127.0.0.1', '0.0.0.0', '[::1]', '[::ffff:127.0.0.1]', 'localhost']) {
      const r = await tool(`/usr/bin/curl -sS -m 5 --noproxy '*' http://${host}:${engine}/`, { enginePort: engine });
      assert.doesNotMatch(r.stdout, /reached/, host);
    }
    // Control: the same forms reach it when another port is the engine's.
    const open = await tool(`/usr/bin/curl -sS -m 5 --noproxy '*' http://[::1]:${engine}/`, { enginePort: 9 });
    assert.equal(open.stdout, 'reached', open.stderr);
  });

  test('curl to a loopback server standing in for the engine port fails while one on another port succeeds', async () => {
    const engine = await listen();
    const other = await listen();
    const otherRun = await listen();
    const over = { enginePort: engine, otherPorts: [otherRun] };
    const curl = (port: number) => tool(`/usr/bin/curl -sS -m 5 --noproxy '*' http://127.0.0.1:${port}/`, over);
    const denied = await curl(engine);
    assert.notEqual(denied.code, 0);
    assert.doesNotMatch(denied.stdout, /reached/);
    const ok = await curl(other);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(ok.stdout, 'reached');
    const deniedRun = await curl(otherRun);
    assert.notEqual(deniedRun.code, 0);
    assert.doesNotMatch(deniedRun.stdout, /reached/);
    const viaName = await tool(`/usr/bin/curl -sS -m 5 --noproxy '*' http://localhost:${engine}/`, over);
    assert.doesNotMatch(viaName.stdout, /reached/);
  });

  test('a cache or config write lands in the run, never in the shared home', async () => {
    const r = await tool('mkdir -p "$npm_config_cache" "$XDG_CACHE_HOME/x" "$HOME/.config" && echo $HOME');
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout.trim(), join(runRoot, 'home'));
    assert.ok(existsSync(join(runRoot, 'cache', 'npm')));
  });

  describe('the cli profile', () => {
    function cli(script: string, brokerPort = 9) {
      const argv = wrap([process.execPath, '-e', script], 'cli', { ...o, claudeBin: '/usr/bin/true', nodeBin: process.execPath, brokerPort });
      return run(argv, { cwd: join(runRoot, 'repo'), env: { PATH: '/usr/bin:/bin', HOME: home } });
    }
    const tryWrite = (p: string) => `try{require('fs').writeFileSync(${JSON.stringify(p)},'x');console.log('wrote ${p}')}catch(e){console.log('denied ${p}')}`;
    const tryRead = (p: string) => `try{require('fs').readFileSync(${JSON.stringify(p)});console.log('read ${p}')}catch(e){console.log('denied ${p}')}`;

    test('writes reach the runtime paths and ~/.claude.json but never settings, projects or the .git', async () => {
      const allowed = [join(home, '.claude', 'debug', 'log.txt'), join(home, '.claude', 'todos', 't.json'), join(runRoot, 'repo', 'a.txt'), join(runRoot, 'ctmp', 'claude-501')];
      const denied = [
        join(home, '.claude', 'shell-snapshots', 'snapshot-zsh-1.sh'),
        join(home, '.claude', 'session-env', 'env.sh'),
        join(home, '.claude', 'statsig', 'cache'),
        join(home, '.claude.json'),
        join(home, '.claude.json.backup'),
        join(home, '.claude.json.tmp.1'),
        join(home, '.claude', 'settings.json'),
        join(home, '.claude', 'settings.local.json'),
        join(home, '.claude', 'CLAUDE.md'),
        join(home, '.claude', 'projects', 'p.jsonl'),
        join(home, 'outside.txt'),
        join(runRoot, 'repo', '.git', 'config'),
        join(runRoot, 'ctl', 'gitconfig'),
      ];
      const r = await cli([...allowed, ...denied].map(tryWrite).join(';'));
      for (const p of allowed) assert.ok(r.stdout.includes(`wrote ${p}`), `${p}: ${r.stdout}${r.stderr}`);
      for (const p of denied) assert.ok(r.stdout.includes(`denied ${p}`), `${p}: ${r.stdout}${r.stderr}`);
      assert.equal(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'), '{}\n');
      assert.equal(readFileSync(join(home, '.claude', 'shell-snapshots', 'snapshot-zsh-1.sh'), 'utf8'), '# his\n');
      assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), '{}\n');
    });

    test('reads of transcripts and gh config fail', async () => {
      const r = await cli([join(home, '.claude', 'projects', 'p.jsonl'), join(home, '.config', 'gh', 'hosts.yml'), join(home, 'outside.txt')].map(tryRead).join(';'));
      assert.equal((r.stdout.match(/^denied /gm) ?? []).length, 3, r.stdout + r.stderr);
    });

    test('/bin/sh runs for the hook, other shells do not, and only the broker port is reachable', async () => {
      const broker = await listen();
      const other = await listen();
      const others = ['/bin/zsh', '/bin/dash', '/bin/csh'].filter((x) => x !== selectedShell() && existsSync(x));
      const script =
        `const cp=require('child_process');try{console.log('sh says '+cp.execFileSync('/bin/sh',['-c','echo ok']).toString().trim())}catch(e){console.log('sh denied')}` +
        `for(const x of ${JSON.stringify(others)}){try{cp.execFileSync(x,['-c','echo shell']);console.log('ran '+x)}catch(e){console.log('denied '+x)}}` +
        `const http=require('http');const get=(p)=>new Promise(r=>{http.get('http://127.0.0.1:'+p,(s)=>{s.resume();r('reached '+p)}).on('error',()=>r('denied '+p))});` +
        `(async()=>{console.log(await get(${broker}));console.log(await get(${other}))})()`;
      const r = await cli(script, broker);
      assert.match(r.stdout, /sh says ok/, r.stdout + r.stderr);
      for (const x of others) assert.ok(r.stdout.includes(`denied ${x}`), `${x}: ${r.stdout}${r.stderr}`);
      assert.ok(r.stdout.includes(`reached ${broker}`), r.stdout + r.stderr);
      assert.ok(r.stdout.includes(`denied ${other}`), r.stdout + r.stderr);
    });
  });
});
