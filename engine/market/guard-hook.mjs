/**
 * The PreToolUse hook every city claude run carries (Task 8). Run by the
 * CLI as `<node> guard-hook.mjs <dir> <dataHome>` with the hook JSON on
 * stdin. Exits 0 to let the call through and 2 (reason on stderr) to refuse.
 *
 * It fails closed: any exception, unparsable, empty or truncated stdin, a
 * missing or non-string path field, an unexpected input shape, a path it
 * cannot resolve, or its own 5 s timeout all exit 2.
 */
// Only node built-ins are imported statically. guard-core.mjs is loaded
// dynamically inside a try: a missing, broken or incomplete module would
// otherwise make node exit 1, which Claude Code treats as non-blocking.
import { closeSync, constants, openSync, statSync, writeSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

/** The guard's functions, set once guard-core.mjs has loaded. */
let forbidden;
let pathAllowed;
let patternAllowed;

const COULD_NOT = 'guard could not check this call';
const MAX_STDIN = 4 * 1024 * 1024;
const MAX_TIMEOUT_MS = 5000;

/** The run tool served by broker-mcp.mjs. */
const RUN_TOOL = 'mcp__palimpsest__run';

/**
 * Path fields per file tool: `required` must be a string, `optional` must be
 * a string when present, `patterns` are glob patterns. Any other field whose
 * name looks like it carries a path is refused.
 */
const FILE_TOOLS = {
  Read: { required: ['file_path'], optional: [], patterns: [] },
  Edit: { required: ['file_path'], optional: [], patterns: [] },
  Write: { required: ['file_path'], optional: [], patterns: [] },
  MultiEdit: { required: ['file_path'], optional: [], patterns: [] },
  NotebookEdit: { required: ['notebook_path'], optional: [], patterns: [] },
  Glob: { required: [], optional: ['path'], patterns: ['pattern'] },
  Grep: { required: [], optional: ['path'], patterns: ['glob'] },
};
const PATHISH_KEY = /path|file|dir|glob|cwd|root|target|dest|src/i;

/** The tool of the call being decided, for the marker line. */
let markerTool = null;

/**
 * Appends one marker line to `<runRoot>/tmp/hook.log` (the run dir is
 * `<runRoot>/repo`, `ship` or `base`), so the engine can show that the hook
 * ran and what it decided. Best effort and never followed through a
 * symlink or blocked on a FIFO: a marker that cannot be written changes no
 * decision.
 */
function mark(decision, reason) {
  try {
    const dir = process.argv[2];
    if (typeof dir !== 'string' || !isAbsolute(dir) || !['repo', 'ship', 'base'].includes(basename(dir))) return;
    const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const fd = openSync(join(dirname(dir), 'tmp', 'hook.log'), flags, 0o600);
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), hook: 'palimpsest-guard', tool: markerTool, decision, ...(reason ? { reason } : {}) });
      writeSync(fd, line + '\n');
    } finally {
      closeSync(fd);
    }
  } catch {
    // the marker is evidence only
  }
}

function refuse(reason) {
  try {
    mark('refused', reason);
    process.stderr.write(`Palimpsest refused this call: ${reason}\n`);
  } finally {
    process.exit(2);
  }
}

function allow() {
  mark('allowed', null);
  process.exit(0);
}

function timeoutMs() {
  const raw = Number(process.env.PALIMPSEST_HOOK_TIMEOUT_MS);
  // The environment may only shorten the timeout, never lengthen it.
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, MAX_TIMEOUT_MS) : MAX_TIMEOUT_MS;
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The reason the call is refused, or null. Throws (and so refuses) on anything it did not expect. */
function decide(raw, dir, dataHome) {
  if (raw.trim() === '') throw new Error('empty');
  const msg = JSON.parse(raw);
  if (!isPlainObject(msg)) throw new Error('not an object');
  if (msg.hook_event_name !== undefined && msg.hook_event_name !== 'PreToolUse') throw new Error('not PreToolUse');
  const tool = msg.tool_name;
  const input = msg.tool_input;
  if (typeof tool === 'string') markerTool = tool.slice(0, 100);
  if (typeof tool !== 'string' || !isPlainObject(input)) throw new Error('bad shape');

  if (tool === RUN_TOOL) {
    for (const k of Object.keys(input)) if (k !== 'command' && k !== 'timeoutMs') throw new Error(`unexpected field ${k}`);
    if (typeof input.command !== 'string') throw new Error('command not a string');
    if (input.timeoutMs !== undefined && typeof input.timeoutMs !== 'number') throw new Error('timeoutMs not a number');
    return forbidden(input.command, dir, dataHome);
  }

  const spec = FILE_TOOLS[tool];
  if (!spec) return 'tool not allowed in a city run';

  const known = new Set([...spec.required, ...spec.optional, ...spec.patterns]);
  for (const k of Object.keys(input)) {
    if (!known.has(k) && PATHISH_KEY.test(k)) throw new Error(`unexpected path field ${k}`);
  }
  for (const k of spec.required) {
    if (typeof input[k] !== 'string') throw new Error(`${k} missing`);
    const r = pathAllowed(tool, input[k], dir);
    if (r) return r;
  }
  for (const k of spec.optional) {
    if (input[k] === undefined) continue;
    if (typeof input[k] !== 'string') throw new Error(`${k} not a string`);
    const r = pathAllowed(tool, input[k], dir);
    if (r) return r;
  }
  for (const k of spec.patterns) {
    if (input[k] === undefined) {
      if (tool === 'Glob') throw new Error('pattern missing');
      continue;
    }
    if (typeof input[k] !== 'string') throw new Error(`${k} not a string`);
    const r = patternAllowed(input[k]);
    if (r) return r;
  }
  return null;
}

async function loadGuard() {
  const core = await import('./guard-core.mjs');
  for (const name of ['forbidden', 'pathAllowed', 'patternAllowed']) {
    if (typeof core[name] !== 'function') throw new Error(`guard-core lacks ${name}`);
  }
  ({ forbidden, pathAllowed, patternAllowed } = core);
}

async function main() {
  const timer = setTimeout(() => refuse(`${COULD_NOT} (timed out)`), timeoutMs());
  try {
    await loadGuard();
    const [dir, dataHome] = process.argv.slice(2);
    if (typeof dir !== 'string' || typeof dataHome !== 'string' || !isAbsolute(dir) || !isAbsolute(dataHome)) {
      refuse(`${COULD_NOT} (no run directory)`);
      return;
    }
    if (!statSync(dir).isDirectory()) {
      refuse(`${COULD_NOT} (no run directory)`);
      return;
    }
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_STDIN) refuse(`${COULD_NOT} (input too large)`);
      chunks.push(c);
    });
    process.stdin.on('error', () => refuse(COULD_NOT));
    process.stdin.on('end', () => {
      try {
        const reason = decide(Buffer.concat(chunks).toString('utf8'), dir, dataHome);
        clearTimeout(timer);
        if (reason) refuse(reason);
        else allow();
      } catch {
        refuse(COULD_NOT);
      }
    });
  } catch {
    refuse(COULD_NOT);
  }
}

// Any exit that is not an explicit allow is a refusal.
process.exitCode = 2;
process.on('uncaughtException', () => refuse(COULD_NOT));
process.on('unhandledRejection', () => refuse(COULD_NOT));
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGPIPE', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2']) {
  try {
    process.on(sig, () => refuse(`${COULD_NOT} (${sig})`));
  } catch {
    // a signal this platform cannot catch
  }
}
main().catch(() => refuse(COULD_NOT));
