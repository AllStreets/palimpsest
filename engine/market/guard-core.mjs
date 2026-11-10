/**
 * The guard (Task 8): one of three layers that keep a city run from pushing,
 * reaching his credentials or writing outside its repository. The other two
 * are the sandbox profiles (sandbox.ts) and the absence of credentials in
 * every agent process (worktree.ts, childEnv). A string this guard misses
 * still cannot push.
 *
 * Plain JavaScript, so the PreToolUse hook (guard-hook.mjs) and the file
 * tool (file-tool.mjs) run under plain `node` with no TypeScript loader.
 * Types are in guard-core.d.mts; guard.ts re-exports them.
 */
import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/** Every reason the guard gives, as readable copy for the run log and the inspection page. */
export const FORBIDDEN_REASONS = Object.freeze({
  push: 'Pushes are made by the engine, never by an agent.',
  remote: 'The git remotes are fixed by the engine.',
  config: 'The git config is fixed by the engine.',
  rewrite: 'History is never rewritten in a city run.',
  resetRemote: 'Resetting to a remote branch is not allowed.',
  rebaseRemote: 'Rebasing onto a remote branch is not allowed.',
  branchDelete: 'Only branches named palimpsest/ may be deleted.',
  tagDelete: 'Tags are never deleted in a city run.',
  gh: 'The GitHub CLI is not available in a city run.',
  rmOutside: 'Recursive removal is allowed only inside the repository.',
  privileged: 'sudo, launchctl, osascript and security are not available in a city run.',
  pipeShell: 'A download is never piped into a shell.',
  gitDir: "The repository's .git directory is not writable.",
  credentials: 'Commands may not name credential files or Claude configuration.',
  reservedPort: 'Commands may not reach the engine, Ollama or another run on loopback.',
  unreadable: 'The guard could not read this command.',
  pathOutside: 'The path is outside the repository.',
  pathGit: "The path is inside the repository's .git directory.",
  pathSymlink: 'The path is or passes through a symlink, which file tools never follow.',
  pathHardlink: 'The file has more than one hard link, so it may be a file outside the repository.',
  pathBad: 'The path is not a usable file path.',
  pathUnresolved: 'The path could not be resolved.',
});

const R = FORBIDDEN_REASONS;

/* ------------------------------------------------------------------ */
/* Normalising a command string                                        */
/* ------------------------------------------------------------------ */

/** Decodes the escapes a shell or an interpreter would turn into letters: \xHH, \NNN, \uHHHH, \u{H..}. */
function decodeEscapes(s) {
  return s
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

function safeCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

/**
 * The command as the shell would read its words: escapes decoded, line
 * continuations joined, backslashes and quotes dropped, `${NAME}` as
 * `$NAME`. Quotes are dropped rather than honoured, so a quoted body
 * (`sh -c "..."`, `node -e "..."`) is scanned like any other text.
 */
function flatten(cmd) {
  let s = decodeEscapes(cmd);
  s = s.replace(/\\\r?\n/g, '');
  s = s.replace(/\$'/g, "'");
  s = s.replace(/\\/g, '');
  s = s.replace(/['"]/g, '');
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, '$$$1');
  return s;
}

/**
 * Splits a flattened command into simple commands: on `;`, `&`, `|`,
 * newlines, parentheses, braces, `!`, command substitutions and backticks,
 * and before every `-exec` of find. Each piece is checked as a command of
 * its own, so whatever a substitution, a subshell or a `sh -c` body runs is
 * checked at command position.
 */
function segments(flat) {
  const marked = flat.replace(/\s(-exec|-execdir|-ok|-okdir)\s/g, '\n');
  return marked
    .split(/\$\(|<\(|>\(|[`;&|\n\r(){}!]/)
    .map((seg) => seg.trim())
    .filter(Boolean)
    .map((seg) => seg.split(/\s+/).filter(Boolean));
}

/** Words a command may be prefixed with that run the rest of the words as the command. */
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'time', 'nice', 'timeout', 'gtimeout', 'xargs', 'builtin', 'eval', 'stdbuf', 'unbuffer', 'caffeinate', 'then', 'do', 'else', 'elif', 'if', 'while', 'until', 'arch', 'chronic', 'parallel', 'watch', 'script']);
/** Options of those wrappers that take a value. */
const WRAPPER_VALUE_OPTS = new Set(['-u', '-n', '-I', '-i', '-L', '-P', '-d', '-E', '-s', '-k', '-s', '-o', '-e', '-C', '-S', '--signal', '--kill-after']);

/** The command word of a simple command and the words after it. */
function commandOf(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i += 1;
      continue;
    }
    const b = base(w);
    if (WRAPPERS.has(b)) {
      i += 1;
      while (i < words.length && words[i].startsWith('-')) {
        if (WRAPPER_VALUE_OPTS.has(words[i])) i += 1;
        i += 1;
      }
      // timeout's duration, nice's adjustment
      if ((b === 'timeout' || b === 'gtimeout') && i < words.length && /^\d/.test(words[i])) i += 1;
      continue;
    }
    return { cmd: b, args: words.slice(i + 1), raw: w };
  }
  return null;
}

function base(word) {
  return basename(word).toLowerCase();
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

function lower(p) {
  return p.toLowerCase();
}

/** True when `p` is `root` or under it, ignoring letter case (the Mac's volume ignores it). */
function within(p, root) {
  const a = lower(p);
  const b = lower(root).replace(/\/+$/, '');
  return a === b || a.startsWith(b + '/') || b === '';
}

/** The real path of the deepest existing ancestor of `p`, plus the rest. */
function physical(p) {
  const abs = resolve(p);
  try {
    return realpathSync.native(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(physical(parent), basename(abs));
  }
}

function realOr(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Resolves a word the way the shell would for a path: `~` and `$HOME` to
 * his home, `$PWD` to the tracked directory, relative paths against the
 * tracked directory. Returns null when it cannot know (another variable,
 * or a relative path after an unknown `cd`).
 */
function resolveWord(word, cwd, home) {
  let w = word;
  if (w === '~' || w.startsWith('~/')) w = home + w.slice(1);
  else if (/^~[^/]+/.test(w)) w = join(dirname(home), w.slice(1));
  w = w.replace(/^\$HOME(?=\/|$)/i, home);
  if (cwd !== null) w = w.replace(/^\$PWD(?=\/|$)/i, cwd);
  if (w.includes('$')) return null;
  if (isAbsolute(w)) return resolve(w);
  if (cwd === null) return null;
  return resolve(cwd, w);
}

/** True when a path has a `.git` component (`.github` and `.gitignore` do not count). */
function hasGitComponent(word) {
  return /(^|\/)\.git(\/|$)/i.test(word);
}

/** Credential and configuration files named anywhere in a command. */
const NAMED_SECRETS = [
  /\.claude\.json/i,
  /\.config\/gh(\/|\b|$)/i,
  /\.netrc\b/i,
  /\.npmrc\b/i,
  /\.git\/config\b/i,
  /\.git-credentials\b/i,
  /library\/keychains/i,
];

/** Paths under his home no command may name, resolved. */
const HOME_SECRETS = ['.claude', '.claude.json', '.config/gh', '.netrc', '.npmrc', '.ssh', '.aws', '.gnupg', '.gitconfig', '.git-credentials', '.config/git', '.docker', 'Library/Keychains'];

function isHomeSecret(p, home) {
  for (const s of HOME_SECRETS) {
    const full = join(home, s);
    if (s === '.claude.json' ? lower(p).startsWith(lower(full)) : within(p, full)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

const PRIVILEGED = new Set(['sudo', 'doas', 'launchctl', 'osascript', 'security']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh']);
const INTERPRETERS = new Set(['node', 'nodejs', 'python', 'python2', 'python3', 'perl', 'ruby', 'deno', 'bun', 'php', 'lua', 'tclsh', 'swift', 'awk', 'gawk', 'osascript', 'expect', 'pwsh', 'irb', 'jshell']);
const WRITE_VERBS = new Set(['chmod', 'chown', 'chgrp', 'chflags', 'xattr', 'cp', 'mv', 'ln', 'tee', 'touch', 'truncate', 'install', 'dd', 'sed', 'perl', 'rsync', 'mkdir', 'rm', 'rmdir', 'unlink', 'patch', 'ditto', 'cat', 'echo', 'printf']);
const REMOTE_REF = /(^|[/:])origin\/|^refs\/remotes\/|@\{(u|upstream|push)\}/i;

/** Git's own options before the subcommand that take a separate value. */
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

/** The rule for one git invocation (`args` are the words after `git`). */
function gitRule(args) {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    const a = args[i];
    if (a === '-c' || a.startsWith('-c') && a.length > 2 && !a.startsWith('--')) return R.config;
    if (a === '--config-env' || a.startsWith('--config-env=')) return R.config;
    if (a.startsWith('--exec-path=')) return R.config;
    if (GIT_VALUE_OPTS.has(a)) i += 1;
    i += 1;
  }
  if (i >= args.length) return null;
  const sub = args[i].toLowerCase();
  const rest = args.slice(i + 1);
  switch (sub) {
    case 'push':
    case 'send-pack':
      return R.push;
    case 'remote':
      return R.remote;
    case 'config':
      return R.config;
    case 'credential':
    case 'credential-store':
    case 'credential-cache':
    case 'credential-osxkeychain':
      return R.credentials;
    case 'filter-branch':
    case 'filter-repo':
      return R.rewrite;
    case 'reset':
      if (rest.some((a) => a.toLowerCase() === '--hard') && rest.some((a) => REMOTE_REF.test(a))) return R.resetRemote;
      return null;
    case 'rebase':
      if (rest.some((a) => REMOTE_REF.test(a))) return R.rebaseRemote;
      return null;
    case 'branch': {
      const del = rest.some((a) => a === '--delete' || /^-[a-zA-Z]*[dD][a-zA-Z]*$/.test(a));
      if (!del) return null;
      const names = rest.filter((a) => !a.startsWith('-'));
      if (rest.some((a) => /^-[a-zA-Z]*r/.test(a) || a === '--remotes')) return R.branchDelete;
      return names.some((n) => !n.startsWith('palimpsest/')) ? R.branchDelete : null;
    }
    case 'update-ref':
      if (rest.some((a) => a === '-d' || a === '--stdin')) {
        const refs = rest.filter((a) => !a.startsWith('-'));
        if (rest.includes('--stdin') || refs.some((r) => !r.startsWith('refs/heads/palimpsest/'))) return R.branchDelete;
      }
      return null;
    case 'tag':
      return rest.some((a) => a === '-d' || a === '--delete') ? R.tagDelete : null;
    default:
      return null;
  }
}

function isRecursiveRm(args) {
  for (const a of args) {
    if (a === '--') break;
    if (a === '--recursive' || /^-[a-zA-Z]*[rR][a-zA-Z]*$/.test(a)) return true;
  }
  return false;
}

/** Operands of a command: words that are not options (everything after `--`). */
function operands(args) {
  const out = [];
  let opts = true;
  for (const a of args) {
    if (opts && a === '--') {
      opts = false;
      continue;
    }
    if (opts && a.startsWith('-') && a !== '-') continue;
    out.push(a);
  }
  return out;
}

/** Strips redirection operators so `>file` and `2>>file` leave `file`, and returns the redirect targets. */
function redirects(words) {
  const targets = [];
  const rest = [];
  for (let i = 0; i < words.length; i++) {
    const m = words[i].match(/^(\d*|&)>>?\|?(.*)$/);
    if (m) {
      if (m[2]) targets.push(m[2]);
      else if (i + 1 < words.length) targets.push(words[++i]);
      continue;
    }
    const inp = words[i].match(/^\d*<+(.*)$/);
    if (inp) {
      if (!inp[1] && i + 1 < words.length) i += 1;
      continue;
    }
    rest.push(words[i]);
  }
  return { targets, rest };
}

/** Words that may name a path: the word itself, or what follows `=` in `--opt=path` or `of=path`. */
function pathish(words) {
  const out = [];
  for (const w of words) {
    const v = w.includes('=') ? w.slice(w.indexOf('=') + 1) : w;
    for (const x of [w, v]) if (x && (x.includes('/') || x.startsWith('.') || x.startsWith('~') || /^\$home/i.test(x))) out.push(x);
  }
  return out;
}

/**
 * Tokens of the whole command, split on anything that is not part of a
 * word or a path, for scanning interpreter bodies (`node -e`, `python -c`)
 * where a command may sit in a list or a string.
 */
function tokens(flat) {
  return flat.split(/[^A-Za-z0-9_./~$@{}:+=-]+/).filter(Boolean);
}

/** Scans tokens for git invocations anywhere (a `git` token followed by a forbidden subcommand). */
function scanGitAnywhere(toks) {
  for (let i = 0; i < toks.length; i++) {
    if (base(toks[i]) !== 'git') continue;
    const r = gitRule(toks.slice(i + 1, i + 12));
    if (r) return r;
  }
  return null;
}

/**
 * The reason `command` must not run in a city run, or null.
 * `dir` is the run's repository (from the run context, never the request)
 * and `dataHome` the Palimpsest data home. `ports` are further loopback
 * ports to refuse beside the engine's 4770 and Ollama's 11434: the engine
 * passes its own port and every other live run's proxy and broker.
 */
export function forbidden(command, dir, dataHome, ports = []) {
  try {
    return check(command, dir, dataHome, ports);
  } catch {
    return R.unreadable;
  }
}

/** The engine's port and Ollama's: no agent command may name either next to a loopback host. */
export const RESERVED_PORTS = Object.freeze([4770, 11434]);

/**
 * A loopback host form (localhost, 127.x.y.z, 0.0.0.0, [::1], ::ffff:127.x)
 * followed by a port: `host:port`, `host port`, `host', port: N` and the like.
 */
const LOOPBACK_PORT = /(?:\blocalhost|\b127(?:\.\d{1,3}){1,3}|\b0\.0\.0\.0|\[?::1\]?|\[?::ffff:127(?:\.\d{1,3}){1,3}\]?)\]?['"`]?\s*(?:[:\s,]|,\s*port\s*[:=])\s*(?:port\s*[:=]\s*)?['"`]?(\d{1,5})(?!\d)/gi;

/** True when `flat` names one of `ports` next to a loopback host form. */
function namesReservedPort(flat, ports) {
  const reserved = new Set([...RESERVED_PORTS, ...ports.filter((p) => Number.isInteger(p))]);
  for (const m of flat.matchAll(LOOPBACK_PORT)) if (reserved.has(Number(m[1]))) return true;
  return false;
}

function check(command, dir, dataHome, ports) {
  if (typeof command !== 'string' || typeof dir !== 'string' || typeof dataHome !== 'string') return R.unreadable;
  if (!Array.isArray(ports)) return R.unreadable;
  if (command.includes('\0') || command.length > 256 * 1024) return R.unreadable;
  const home = homedir();
  const dirAbs = resolve(dir);
  const dirReal = realOr(dirAbs);
  const flat = flatten(command);

  // Named credential files, anywhere in the text.
  for (const re of NAMED_SECRETS) if (re.test(flat)) return R.credentials;
  if (/(~[^/\s]*|\$home)\/+\.claude\b/i.test(flat) || lower(flat).includes(lower(join(home, '.claude')))) return R.credentials;

  // The engine, Ollama or another live run, named on loopback.
  if (namesReservedPort(flat, ports) || namesReservedPort(command, ports)) return R.reservedPort;

  // A download piped or substituted into a shell or an interpreter.
  if (/\b(curl|wget)\b[^\n;&]*\|\s*(\S*\/)?(sudo\s+|env\s+)?(\S*\/)?(sh|bash|zsh|dash|ksh|fish|python[0-9.]*|node|perl|ruby)\b/i.test(flat)) return R.pipeShell;
  if (/\b(sh|bash|zsh|dash|ksh|source|\.)\s[^\n;]*(\$\(|`|<\()[^\n;]*\b(curl|wget)\b/i.test(flat)) return R.pipeShell;

  // Git anywhere, including inside interpreter bodies and lists.
  const toks = tokens(flat);
  const anywhere = scanGitAnywhere(toks);
  if (anywhere) return anywhere;

  let cwd = dirAbs;
  let interpreter = false;
  for (const words of segments(flat)) {
    const { targets, rest } = redirects(words);
    for (const t of targets) {
      if (/^&?\d*$/.test(t) || t === '/dev/null') continue;
      if (hasGitComponent(t)) return R.gitDir;
      const p = resolveWord(t, cwd, home);
      if (p && isHomeSecret(p, home)) return R.credentials;
    }
    // Paths named anywhere in the command, resolved where the shell would.
    for (const w of pathish(rest)) {
      const p = resolveWord(w, cwd, home);
      if (p && (isHomeSecret(p, home) || isHomeSecret(physical(p), home))) return R.credentials;
    }

    const c = commandOf(rest);
    if (!c) continue;
    const { cmd, args, raw } = c;
    // A command word built from a variable (`x=gh; $x pr list`) cannot be read.
    if (raw.includes('$')) return R.unreadable;
    if (INTERPRETERS.has(cmd) || SHELLS.has(cmd)) interpreter = true;
    if (cmd === 'git') {
      const r = gitRule(args);
      if (r) return r;
      continue;
    }
    if (cmd === 'gh') return R.gh;
    if (PRIVILEGED.has(cmd)) return R.privileged;
    if (cmd === 'cd' || cmd === 'pushd') {
      const to = operands(args)[0];
      cwd = to === undefined ? home : to === '-' ? null : resolveWord(to, cwd, home);
      continue;
    }
    if (cmd === 'popd') {
      cwd = null;
      continue;
    }
    if (cmd === 'rm') {
      const recursive = isRecursiveRm(args);
      for (const t of operands(args)) {
        if (hasGitComponent(t)) return R.gitDir;
        if (!recursive) continue;
        const p = resolveWord(t, cwd, home);
        if (p === null) return R.rmOutside;
        const phys = physical(p);
        for (const q of [p, phys]) {
          if (lower(q) === lower(dirAbs) || lower(q) === lower(dirReal)) return R.rmOutside;
          if (!within(q, dirAbs) && !within(q, dirReal)) return R.rmOutside;
          if (within(q, dataHome) && !within(q, dirAbs) && !within(q, dirReal)) return R.rmOutside;
          if (within(q, join(dirAbs, '.git')) || within(q, join(dirReal, '.git'))) return R.gitDir;
        }
      }
      continue;
    }
    if (WRITE_VERBS.has(cmd) && args.some((a) => hasGitComponent(a.includes('=') ? a.slice(a.indexOf('=') + 1) : a))) {
      if (cmd === 'cat' || cmd === 'echo' || cmd === 'printf') continue; // reads; redirect targets are checked above
      return R.gitDir;
    }
  }

  // Inside an interpreter or a shell body a command may hide in a string or a list.
  if (interpreter) {
    for (const t of toks) {
      const b = base(t);
      if (b === 'gh') return R.gh;
      if (PRIVILEGED.has(b)) return R.privileged;
    }
    if (/(^|[^a-z0-9_])\.git\//i.test(flat) && /write|open|unlink|rm|chmod|append|copy|rename|symlink|link/i.test(flat)) return R.gitDir;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* File tool paths (ruling 29)                                         */
/* ------------------------------------------------------------------ */

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep']);

/** `p` relative to `root` when it is `root` or under it (ignoring case), else null. */
function relInside(p, root) {
  const a = lower(p);
  const b = lower(root).replace(/\/+$/, '');
  if (a === b) return '';
  if (a.startsWith(b + '/')) return p.slice(b.length + 1);
  return null;
}

/**
 * The reason a file tool may not touch `path`, or null. Resolves the target
 * against `dir`, checks every component from `dir` down with lstat, and
 * refuses any path that is or passes through a symlink, resolves outside
 * `dir`, lands inside a `.git` directory, or is a file with another hard
 * link. A target that does not exist yet is checked through its nearest
 * existing parent.
 */
export function pathAllowed(tool, path, dir) {
  try {
    return checkPath(tool, path, dir);
  } catch {
    return R.pathUnresolved;
  }
}

function checkPath(tool, path, dir) {
  if (!FILE_TOOLS.has(tool)) return R.pathBad;
  if (typeof path !== 'string' || path === '' || path.includes('\0')) return R.pathBad;
  if (typeof dir !== 'string' || !isAbsolute(dir)) return R.pathBad;
  if (path.startsWith('~')) return R.pathOutside;
  const dirAbs = resolve(dir);
  let dirReal;
  try {
    dirReal = realpathSync.native(dirAbs);
  } catch {
    return R.pathUnresolved;
  }
  const abs = resolve(dirAbs, path);
  const rel = relInside(abs, dirAbs) ?? relInside(abs, dirReal);
  if (rel === null) return R.pathOutside;
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((p) => lower(p) === '.git')) return R.pathGit;

  let cur = dirReal;
  let deepest = dirReal;
  let target = null;
  for (let i = 0; i < parts.length; i++) {
    cur = join(cur, parts[i]);
    let st;
    try {
      st = lstatSync(cur);
    } catch (err) {
      if (err && err.code === 'ENOENT') break;
      return R.pathUnresolved;
    }
    if (st.isSymbolicLink()) return R.pathSymlink;
    deepest = cur;
    if (i === parts.length - 1) target = st;
    else if (!st.isDirectory()) return R.pathUnresolved;
  }
  const real = realpathSync.native(deepest);
  if (relInside(real, dirReal) === null) return R.pathOutside;
  if (relInside(real, join(dirReal, '.git')) !== null) return R.pathGit;
  if (target && target.isFile() && target.nlink > 1) return R.pathHardlink;
  return null;
}

/**
 * The reason a glob pattern (Glob's `pattern`, Grep's `glob`) may not be
 * used, or null: absolute patterns, `~` and any `..` segment are refused.
 */
export function patternAllowed(pattern) {
  if (typeof pattern !== 'string' || pattern.includes('\0')) return R.pathBad;
  if (pattern.startsWith('/') || pattern.startsWith('~') || /\$/.test(pattern)) return R.pathOutside;
  if (/(^|[/{,])\.\.([/},]|$)/.test(pattern)) return R.pathOutside;
  return null;
}
