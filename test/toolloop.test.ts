/**
 * The local tool loop (Task 10). A scripted transport stands in for the
 * model; every file tool and command runs through the broker (Task 8) with
 * PALIMPSEST_SANDBOX=off on a temp home, never in this process.
 */
import assert from 'node:assert/strict';
import fs, { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { RunLogLine, WorkInput } from '../engine/market/provider.js';
import { LOOP_TOOLS, runToolLoop, type ChatChunk, type ChatMessage, type ChatTransport, type ToolSpec } from '../engine/market/toolloop.js';
import type { Agent, Job, RunProgress } from '../shared/types.js';

const ENV_KEYS = ['PALIMPSEST_HOME', 'PALIMPSEST_SANDBOX'];
let previousEnv: Record<string, string | undefined>;
let tempDir: string;

beforeEach(() => {
  previousEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'palimpsest-toolloop-test-')));
  process.env.PALIMPSEST_HOME = join(tempDir, 'data');
  process.env.PALIMPSEST_SANDBOX = 'off';
  mkdirSync(join(tempDir, 'home', '.config', 'gh'), { recursive: true });
  writeFileSync(join(tempDir, 'home', '.config', 'gh', 'hosts.yml'), 'github.com:\n  oauth_token: gho_STANDIN_SECRET\n');
  mkdirSync(join(tempDir, 'home', '.claude'), { recursive: true });
  writeFileSync(join(tempDir, 'home', '.claude', 'settings.json'), '{"stand":"in"}\n');
  writeFileSync(join(tempDir, 'outside'), 'OUTSIDE_SECRET\n');
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (previousEnv[k] === undefined) delete process.env[k];
    else process.env[k] = previousEnv[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

function makeJob(): Job {
  return {
    id: 'job-1', repo: 'acme/widgets', source: 'issue', issue: 7, url: null, title: 'Add a changelog',
    body: 'Please add `docs/CHANGELOG.md`.', scope: ['docs/**'], acceptance: ['docs/CHANGELOG.md exists'], tier: 'normal', value: 60,
    status: 'running', attempts: 0, postedAt: '2026-11-01T00:00:00.000Z', bidsCloseAt: null, awardedBid: null, runId: 'run-1',
    floorId: null, closedAt: null, excludedFirms: [], haltedFrom: null,
  };
}

const agent = { id: 'agent-1', firmId: 'firm-1', name: 'Wren', model: 'ollama:qwen2.5-coder:7b', instructions: 'Keep changes small.', maxTurns: 25 } as unknown as Agent;

function makeRun(runId: string) {
  const runRoot = join(tempDir, 'data', 'runs', runId);
  const dir = join(runRoot, 'repo');
  for (const d of ['repo/.git', 'repo/src', 'tmp', 'home', 'cache', 'ctl']) mkdirSync(join(runRoot, d), { recursive: true });
  writeFileSync(join(dir, '.git', 'config'), '[core]\n\tbare = false\n');
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  return { runId, runRoot, dir };
}

function workInput(runId: string, over: Partial<WorkInput> = {}) {
  const run = makeRun(runId);
  const logs: RunLogLine[] = [];
  const ticks: Partial<RunProgress>[] = [];
  const input: WorkInput = {
    job: makeJob(), agent, persona: 'Wren is quick.', runId, dir: run.dir, branch: 'palimpsest/job-1', plan: null, examples: [],
    log: (l) => logs.push(l), onProgress: (p) => ticks.push(p), signal: new AbortController().signal,
    caps: { maxTurns: 25, maxMinutes: 10, maxCredits: 1000 },
    ...over,
  };
  return { input, logs, ticks, run };
}

type Turn = ChatChunk[];
let callId = 0;
const call = (name: string, args: unknown): ChatChunk => ({ type: 'tool_call', call: { id: `c${++callId}`, name, arguments: args } });
const text = (t: string): ChatChunk => ({ type: 'text', text: t });
const usage = (seconds: number): ChatChunk => ({ type: 'usage', usage: { input: 100, output: 20, seconds } });

/** Replays one scripted turn per chat() call and keeps a deep copy of every request. */
function scripted(turns: Turn[] | ((n: number) => Turn)) {
  const seen: Array<{ messages: ChatMessage[]; tools: ToolSpec[] }> = [];
  const transport: ChatTransport = {
    async *chat(messages, tools) {
      seen.push({ messages: JSON.parse(JSON.stringify(messages)), tools });
      const n = seen.length - 1;
      const turn = typeof turns === 'function' ? turns(n) : turns[n];
      if (!turn) throw new Error('script ran out');
      for (const c of turn) yield c;
    },
  };
  return { transport, seen };
}

const opts = { maxTurns: 10, maxMs: 60_000, creditsFor: (u: { seconds: number }) => u.seconds * 0.01, reap: async () => [] as number[] };

function toolMessages(seen: Array<{ messages: ChatMessage[] }>, i: number) {
  return seen[i].messages.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool');
}

describe('runToolLoop', () => {
  test('offers exactly the seven tools', () => {
    assert.deepEqual(LOOP_TOOLS.map((t) => t.name).sort(), ['edit_file', 'finish', 'list_files', 'read_file', 'run', 'search', 'write_file']);
  });

  test('a forbidden run is refused and the model is told why', async () => {
    const { input, logs } = workInput('run-refuse');
    const marker = join(tempDir, 'pushed');
    const { transport, seen } = scripted([[call('run', { command: `git push origin main; touch ${marker}` })], [call('finish', { summary: 'gave up' })]]);
    const r = await runToolLoop(transport, input, opts);
    assert.equal(r.ended, 'finished');
    const [tm] = toolMessages(seen, 1);
    assert.equal(tm.isError, true);
    assert.match(tm.content, /^Refused/);
    assert.ok(tm.content.length > 'Refused: '.length);
    assert.throws(() => fs.statSync(marker));
    assert.ok(logs.some((l) => l.kind === 'refused'));
  });

  test('file tools stay inside the run dir', async () => {
    const { input } = workInput('run-inside');
    const { transport, seen } = scripted([
      [call('read_file', { path: '../../../../outside' }), call('read_file', { path: '.git/config' }), call('write_file', { path: '.git/config', content: 'x' })],
      [call('finish', { summary: 'done' })],
    ]);
    await runToolLoop(transport, input, opts);
    const tms = toolMessages(seen, 1);
    assert.equal(tms.length, 3);
    for (const tm of tms) assert.match(tm.content, /^Refused/);
    assert.doesNotMatch(JSON.stringify(seen), /OUTSIDE_SECRET|bare = false/);
    assert.equal(readFileSync(join(input.dir, '.git', 'config'), 'utf8'), '[core]\n\tbare = false\n');
  });

  test('read_file of a symlink to a temp hosts.yml stand-in is refused and nothing reaches the transport', async () => {
    const { input } = workInput('run-symread');
    symlinkSync(join(tempDir, 'home', '.config', 'gh', 'hosts.yml'), join(input.dir, 'hosts.yml'));
    const { transport, seen } = scripted([[call('read_file', { path: 'hosts.yml' })], [call('finish', { summary: 'done' })]]);
    await runToolLoop(transport, input, opts);
    assert.match(toolMessages(seen, 1)[0].content, /^Refused/);
    assert.doesNotMatch(JSON.stringify(seen), /STANDIN_SECRET/);
  });

  test('write_file through a symlink to a temp settings.json stand-in is refused', async () => {
    const { input } = workInput('run-symwrite');
    const target = join(tempDir, 'home', '.claude', 'settings.json');
    symlinkSync(target, join(input.dir, 'settings.json'));
    const { transport, seen } = scripted([
      [call('write_file', { path: 'settings.json', content: '{"hooks":"evil"}' }), call('edit_file', { path: 'settings.json', old_text: 'stand', new_text: 'evil' })],
      [call('finish', { summary: 'done' })],
    ]);
    await runToolLoop(transport, input, opts);
    for (const tm of toolMessages(seen, 1)) assert.match(tm.content, /^Refused/);
    assert.equal(readFileSync(target, 'utf8'), '{"stand":"in"}\n');
  });

  test('file tools work inside the run dir and count changed files', async () => {
    const { input, ticks } = workInput('run-ok');
    const { transport, seen } = scripted([
      [call('write_file', { path: 'docs/CHANGELOG.md', content: '# Changelog\n' }), call('read_file', { path: 'src/a.ts' })],
      [call('edit_file', { path: 'docs/CHANGELOG.md', old_text: '# Changelog', new_text: '# Changes' }), call('list_files', { path: 'docs' }), call('search', { pattern: 'const a' })],
      [call('finish', { summary: 'Added the changelog.' })],
    ]);
    const r = await runToolLoop(transport, input, opts);
    assert.equal(r.ended, 'finished');
    assert.equal(readFileSync(join(input.dir, 'docs', 'CHANGELOG.md'), 'utf8'), '# Changes\n');
    assert.match(toolMessages(seen, 1)[1].content, /export const a = 1/);
    const second = toolMessages(seen, 2).slice(2);
    assert.match(second[1].content, /CHANGELOG\.md/);
    assert.match(second[2].content, /src\/a\.ts/);
    assert.equal(ticks.at(-1)?.filesChanged, 1);
  });

  test('tool call arguments are validated against the schema before anything runs', async () => {
    const { input } = workInput('run-schema');
    const { transport, seen } = scripted([
      [
        call('write_file', { path: 'x.md' }),
        call('write_file', { path: 'y.md', content: 'y', mode: '777' }),
        call('run', { command: 42 }),
        call('read_file', '{not json'),
        call('delete_everything', {}),
        call('read_file', JSON.stringify({ path: 'src/a.ts' })),
      ],
      [call('finish', { summary: 'done' })],
    ]);
    await runToolLoop(transport, input, opts);
    const tms = toolMessages(seen, 1);
    for (const tm of tms.slice(0, 5)) {
      assert.equal(tm.isError, true);
      assert.match(tm.content, /^Invalid tool call/);
    }
    assert.match(tms[5].content, /export const a/);
    assert.throws(() => fs.statSync(join(input.dir, 'y.md')));
    assert.throws(() => fs.statSync(join(input.dir, 'x.md')));
  });

  test('file tools never open a file in the engine process', async () => {
    const { input } = workInput('run-noopen');
    const opened: string[] = [];
    const real = { open: fs.open, openSync: fs.openSync, popen: fs.promises.open };
    fs.open = ((p: fs.PathLike, ...rest: unknown[]) => {
      opened.push(String(p));
      return (real.open as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.open;
    fs.openSync = ((p: fs.PathLike, ...rest: unknown[]) => {
      opened.push(String(p));
      return (real.openSync as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync;
    fs.promises.open = ((p: fs.PathLike, ...rest: unknown[]) => {
      opened.push(String(p));
      return (real.popen as (...a: unknown[]) => Promise<fs.promises.FileHandle>)(p, ...rest);
    }) as typeof fs.promises.open;
    syncBuiltinESMExports();
    try {
      const { transport } = scripted([
        [call('write_file', { path: 'docs/a.md', content: 'a' }), call('read_file', { path: 'src/a.ts' }), call('edit_file', { path: 'src/a.ts', old_text: '1', new_text: '2' })],
        [call('list_files', { recursive: true }), call('search', { pattern: 'a' })],
        [call('finish', { summary: 'done' })],
      ]);
      const r = await runToolLoop(transport, input, opts);
      assert.equal(r.ended, 'finished');
    } finally {
      fs.open = real.open;
      fs.openSync = real.openSync;
      fs.promises.open = real.popen;
      syncBuiltinESMExports();
    }
    // The only files the engine opens are its own control scripts, copied into ctl/bin before the file tool runs.
    const bin = join(tempDir, 'data', 'runs', 'run-noopen', 'ctl', 'bin') + '/';
    assert.deepEqual(opened.filter((p) => !p.startsWith(bin)), []);
    assert.ok(!opened.some((p) => p.startsWith(input.dir)));
    assert.equal(readFileSync(join(input.dir, 'src', 'a.ts'), 'utf8'), 'export const a = 2;\n');
  });

  test('the loop stops at the turn cap with capped', async () => {
    const { input } = workInput('run-cap');
    const { transport, seen } = scripted(() => [call('list_files', {})]);
    const r = await runToolLoop(transport, input, { ...opts, maxTurns: 3 });
    assert.equal(r.ended, 'capped');
    assert.match(r.reason ?? '', /turn/);
    assert.equal(seen.length, 3);
  });

  test('the loop stops at the credit cap with capped', async () => {
    const { input } = workInput('run-credits', { caps: { maxTurns: 25, maxMinutes: 10, maxCredits: 1 } });
    const { transport, seen } = scripted(() => [usage(60), call('list_files', {})]);
    const r = await runToolLoop(transport, input, opts);
    assert.equal(r.ended, 'capped');
    assert.match(r.reason ?? '', /credit/);
    assert.equal(seen.length, 2);
    assert.equal(r.usage.seconds, 120);
    assert.equal(r.usage.credits, 1.2);
  });

  test('the loop stops at the wall cap with capped, even inside a hanging turn', async () => {
    const { input } = workInput('run-wall');
    const transport: ChatTransport = {
      async *chat(_m, _t, signal) {
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      },
    };
    const r = await runToolLoop(transport, input, { ...opts, maxMs: 200 });
    assert.equal(r.ended, 'capped');
    assert.match(r.reason ?? '', /time/);
  });

  test('an abort ends the loop as aborted', async () => {
    const ac = new AbortController();
    const { input } = workInput('run-abort', { signal: ac.signal });
    const { transport } = scripted((n) => {
      if (n === 1) ac.abort();
      return [call('list_files', {})];
    });
    const r = await runToolLoop(transport, input, opts);
    assert.equal(r.ended, 'aborted');
  });

  test('a transport failure ends the loop as crashed', async () => {
    const { input } = workInput('run-crash');
    const transport: ChatTransport = {
      // eslint-disable-next-line require-yield
      async *chat() {
        throw new Error('model went away');
      },
    };
    const r = await runToolLoop(transport, input, opts);
    assert.equal(r.ended, 'crashed');
    assert.match(r.reason ?? '', /model went away/);
  });

  test('finish ends with the summary', async () => {
    const { input, ticks } = workInput('run-finish');
    const { transport, seen } = scripted([[text('Looking.'), usage(2), call('list_files', {})], [usage(3), call('finish', { summary: 'Added the changelog.' }), call('run', { command: 'echo never' })]]);
    const r = await runToolLoop(transport, input, opts);
    assert.equal(r.ended, 'finished');
    assert.equal(r.summary, 'Added the changelog.');
    assert.equal(r.reason, null);
    assert.equal(r.usage.seconds, 5);
    assert.equal(seen.length, 2);
    assert.equal(ticks.at(-1)?.turns, 2);
    assert.equal(seen[0].messages[0].role, 'system');
    assert.match((seen[0].messages[1] as { content: string }).content, /Add a changelog/);
  });

  test('a reply with no tool call ends with its text as the summary', async () => {
    const { input } = workInput('run-text');
    const { transport } = scripted([[text('Nothing to do here.')]]);
    const r = await runToolLoop(transport, input, opts);
    assert.equal(r.ended, 'finished');
    assert.equal(r.summary, 'Nothing to do here.');
  });

  test('refuses a dir that is not the run root repo', async () => {
    const { input } = workInput('run-wrongdir');
    const { transport, seen } = scripted([[call('finish', { summary: 'x' })]]);
    const r = await runToolLoop(transport, { ...input, dir: join(tempDir, 'home') }, opts);
    assert.equal(r.ended, 'crashed');
    assert.equal(seen.length, 0);
  });

  test('reaps the run at the end, also when capped', async () => {
    const { input, run } = workInput('run-reap');
    const reaped: string[] = [];
    const { transport } = scripted(() => [call('list_files', {})]);
    await runToolLoop(transport, input, { ...opts, maxTurns: 1, reap: async (root: string) => (reaped.push(root), []) });
    assert.deepEqual(reaped, [run.runRoot]);
  });
});
