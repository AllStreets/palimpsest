/**
 * A fake graduates' server for tests (Phase 4 Task 26): `mlx_lm.server`
 * spawns go to a fake child that lives until it is killed, the port picker
 * hands out a fake HTTP server on port 0 that answers as the real one does,
 * `lsof` and `ps` go to a fake runner, and the idle timer is held by the
 * test. Everything else is passed to the real spawner and runner, and no
 * Python is ever started (test safety rule 11). Call `installMlx()` after
 * `setUp()` and `uninstallMlx()` before `tearDown()`.
 */
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

import { openDb } from '../engine/db.js';
import { realRunner, realSpawner, setRunner, setSpawner, type Runner, type SpawnDone, type Spawned, type SpawnLine, type SpawnOpts, type Spawner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { setPortPicker, setServerKill, setServerTimers, stopServer } from '../engine/market/mlx.js';
import { loraBaseDir } from '../engine/school/lora.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import type { ModelRef } from '../shared/types.js';

export const KEYS = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'HF_TOKEN'];
export const GRAD_1: ModelRef = 'mlx:grad-qwen25c7-1';
export const GRAD_2: ModelRef = 'mlx:grad-qwen25c7-2';
export const LORA_1 = 'lora-0000000a';
export const LORA_2 = 'lora-0000000b';
/** The pid every fake server child has. */
export const SERVER_PID = 5151;

export interface FakeChild {
  cmd: string;
  args: string[];
  opts: SpawnOpts;
  kills: string[];
  end(code: number | null, signal?: string | null): void;
}

export interface Mlx {
  spawned: FakeChild[];
  bodies: Array<Record<string, unknown>>;
  replies: Array<{ json: unknown; delayMs?: number }>;
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;
  port: number;
  /** What `lsof` says listens on the port (default: the fake child). */
  listeners: number[];
  /** What `ps -o command= -p <pid>` answers, by pid. */
  ps: Map<number, string>;
  /** Every group kill `reapStrayServer` sent. */
  kills: Array<{ pid: number; signal: string }>;
  runs: string[][];
}

let state: Mlx | null = null;
let server: Server | null = null;
const saved: Record<string, string | undefined> = {};

const fakeSpawner: Spawner = (cmd, args, opts): Spawned => {
  if (![cmd, ...args].includes('mlx_lm.server')) {
    assert.ok(!/python/.test([cmd, ...args].join(' ')), 'no Python under npm test');
    return realSpawner(cmd, args, opts);
  }
  let closed = false;
  let resolveDone!: (d: SpawnDone) => void;
  const done = new Promise<SpawnDone>((r) => {
    resolveDone = r;
  });
  const waiting: Array<(r: IteratorResult<SpawnLine>) => void> = [];
  const f: FakeChild = {
    cmd,
    args,
    opts,
    kills: [],
    end(code, signal = null) {
      if (closed) return;
      closed = true;
      for (const w of waiting.splice(0)) w({ value: undefined, done: true });
      resolveDone({ code, signal });
    },
  };
  state!.spawned.push(f);
  const lines: AsyncIterable<SpawnLine> = {
    [Symbol.asyncIterator]: () => ({
      next: () => (closed ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => waiting.push(r))),
    }),
  };
  return {
    pid: SERVER_PID,
    lines,
    kill: (sig = 'SIGTERM') => {
      f.kills.push(sig);
      f.end(null, sig);
    },
    done,
  };
};

const fakeRunner: Runner = async (cmd, args, opts) => {
  const s = state!;
  if (cmd === '/usr/sbin/lsof') {
    s.runs.push([cmd, ...args]);
    return { stdout: s.listeners.map((p) => `${p}\n`).join(''), stderr: '', code: s.listeners.length ? 0 : 1 };
  }
  if (cmd === '/bin/ps') {
    s.runs.push([cmd, ...args]);
    const pid = Number(args.at(-1));
    const line = s.ps.get(pid);
    return line === undefined ? { stdout: '', stderr: '', code: 1 } : { stdout: `${line}\n`, stderr: '', code: 0 };
  }
  return realRunner(cmd, args, opts);
};

function fakePython(): string {
  const p = join(paths().school, '..', 'fake-venv', 'bin', 'python');
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '#!/bin/sh\nexit 99\n');
  chmodSync(p, 0o755);
  return p;
}

/** A whole safetensors file as mlx-lm writes one. */
export function safetensors(n = 4): Buffer {
  const header = JSON.stringify({ __metadata__: { format: 'mlx' }, 'a.lora_a': { dtype: 'F32', shape: [n], data_offsets: [0, 4 * n] } });
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(Buffer.byteLength(header)));
  return Buffer.concat([len, Buffer.from(header), Buffer.alloc(4 * n)]);
}

/** The base as a finished download leaves it. */
export function baseReady(): void {
  mkdirSync(loraBaseDir(), { recursive: true });
  writeFileSync(join(loraBaseDir(), 'config.json'), '{"model_type":"qwen2"}\n');
  patchSettings({ school: { ...getSettings().school, baseModelReady: true } });
}

export function adapterDir(id: string): string {
  return join(paths().school, 'lora', 'adapters', id);
}

/** A LoRA's record and its adapter on disk, as lora.ts leaves them. */
export function lora(id: string, status: 'trained' | 'paused' | 'failed', createdAt: string): void {
  const runs = join(paths().school, 'ctl', 'lora');
  mkdirSync(runs, { recursive: true });
  mkdirSync(adapterDir(id), { recursive: true });
  writeFileSync(join(adapterDir(id), 'adapters.safetensors'), safetensors());
  const base = getSettings().school.baseModel;
  writeFileSync(
    join(runs, `${id}.json`),
    JSON.stringify({ id, base, status, reason: null, iters: 600, saved: status === 'trained' ? 600 : 230, examples: 120, createdAt, endedAt: createdAt, trains: [], resumes: [], pauses: [], good: 0, torn: [], optimizerReset: false }),
  );
}

/** A graduate row as Task 27 writes it. */
export function graduate(model: ModelRef, loraId: string): void {
  const g = { id: model.slice(4), model, base: getSettings().school.baseModel, loraId, sealed: { mean: 0.6, lo: 0.5, hi: 0.7 }, baseSealed: { mean: 0.4, lo: 0.3, hi: 0.5 }, vsBase: { diff: 0.2, lo: 0.1, hi: 0.3 }, examples: 120, arenas: [], at: '2026-11-12T03:00:00.000Z', agentId: null };
  openDb().prepare('INSERT OR REPLACE INTO graduates (id, json) VALUES (?, ?)').run(g.id, JSON.stringify(g));
}

/** An OpenAI chat completion as mlx_lm.server answers it. */
export function completion(message: Record<string, unknown>, finish = 'stop'): unknown {
  return { id: 'chatcmpl-1', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: '', ...message }, finish_reason: finish }], usage: { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340 } };
}

/** Installs the fake server, spawner, runner and timers, the base and two graduates (GRAD_1 on LORA_1, GRAD_2 on LORA_2). */
export async function installMlx(): Promise<Mlx> {
  for (const k of ['PALIMPSEST_PYTHON', ...KEYS]) saved[k] = process.env[k];
  const s: Mlx = { spawned: [], bodies: [], replies: [], timers: [], port: 0, listeners: [SERVER_PID], ps: new Map(), kills: [], runs: [] };
  state = s;
  process.env.PALIMPSEST_PYTHON = fakePython();
  for (const k of KEYS) process.env[k] = 'secret-value';
  server = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
        res.writeHead(404).end();
        return;
      }
      s.bodies.push(JSON.parse(b));
      const reply = s.replies[s.bodies.length - 1];
      if (!reply) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'script ran out' }));
        return;
      }
      const t = setTimeout(() => {
        if (!res.destroyed) res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply.json));
      }, reply.delayMs ?? 0);
      res.on('close', () => clearTimeout(t));
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  s.port = (server!.address() as { port: number }).port;
  setSpawner(fakeSpawner);
  setRunner(fakeRunner);
  setPortPicker(async () => s.port);
  setServerKill((pid, signal) => {
    s.kills.push({ pid, signal });
    return true;
  });
  setServerTimers({
    set: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      s.timers.push(t);
      return t;
    },
    clear: (t) => {
      (t as { cleared: boolean }).cleared = true;
    },
  });
  baseReady();
  lora(LORA_1, 'trained', '2026-11-10T03:00:00.000Z');
  lora(LORA_2, 'trained', '2026-11-11T03:00:00.000Z');
  graduate(GRAD_1, LORA_1);
  graduate(GRAD_2, LORA_2);
  return s;
}

export async function uninstallMlx(): Promise<void> {
  await stopServer();
  setPortPicker(null);
  setServerTimers(null);
  setServerKill(null);
  setSpawner(realSpawner);
  setRunner(realRunner);
  server?.closeAllConnections();
  if (server) await new Promise((r) => server!.close(r));
  server = null;
  state = null;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/** Waits until `cond` holds, a few event-loop turns at a time (a real 2 s bound). */
export async function until(cond: () => boolean): Promise<void> {
  const end = Date.now() + 2_000;
  while (!cond()) {
    if (Date.now() > end) throw new Error('the condition never held');
    await new Promise((r) => setTimeout(r, 5));
  }
}
