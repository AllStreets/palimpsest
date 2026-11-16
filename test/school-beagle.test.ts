/**
 * Beagle as a library (Phase 4 Task 4, ruling 1): Beagle's store lives under
 * the temp school, and every model call Beagle makes goes through the city's
 * school lease, its caps and its credits rows. No real model and no network:
 * the claude and ollama backends are fakes.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { openDb } from '../engine/db.js';
import { paths } from '../engine/home.js';
import { creditsFor, liveLeaseCount, noteSseClients, resetBudget, treasury } from '../engine/market/budget.js';
import { fakeProvider } from '../engine/market/fake-provider.js';
import { withSpent, type CompleteInput, type CompleteResult, type Usage } from '../engine/market/provider.js';
import { resetProviders, setProvider } from '../engine/market/providers.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import type { BeagleApi, BeagleArena, BeagleGenome } from '../engine/school/beagle-api.js';
import { closeBeagle, loadBeagle, schoolDriver } from '../engine/school/beagle.js';
import { ci } from '../engine/school/stats.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const MIN = 60_000;
const HOUR = 60 * MIN;
/** 14:00 local time: daytime, attended (an app client is connected). */
const NOW = new Date(2026, 10, 9, 14, 0, 0).getTime();
/** 02:00 local time: night, so the city is unattended whoever is connected. */
const NIGHT = new Date(2026, 10, 10, 2, 0, 0).getTime();

let tempDir: string;
const saved: Record<string, string | undefined> = {};
const ENV = ['PALIMPSEST_HOME', 'PALIMPSEST_CLAUDE_PROJECTS', 'PALIMPSEST_TEST_PROJECTS', 'BEAGLE_HOME', 'BEAGLE_BACKOFF_MS', 'HOME'];

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  tempDir = mkdtempSync(join(tmpdir(), 'palimpsest-beagle-test-'));
  process.env.PALIMPSEST_HOME = join(tempDir, 'home');
  process.env.PALIMPSEST_CLAUDE_PROJECTS = join(tempDir, 'projects');
  process.env.PALIMPSEST_TEST_PROJECTS = '1';
  process.env.BEAGLE_BACKOFF_MS = '1';
  mkdirSync(join(tempDir, 'projects'), { recursive: true });
  resetBudget();
  resetProviders();
  noteSseClients(1, NOW - MIN);
});

afterEach(() => {
  closeBeagle();
  resetBudget();
  resetProviders();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tempDir, { recursive: true, force: true });
});

/** Writes his latest usage reading as the hook does, taken at `at`. */
function reading(o: { five: number; at?: number }): void {
  const at = o.at ?? NOW;
  writeFileSync(
    join(paths().usage, 'latest.json'),
    JSON.stringify({
      at: Math.floor(at / 1000),
      rate_limits: {
        five_hour: { used_percentage: o.five, resets_at: Math.floor((at + HOUR) / 1000) },
        seven_day: { used_percentage: 10, resets_at: Math.floor((at + 3 * 24 * HOUR) / 1000) },
      },
    }),
  );
}

/** Marks his Claude Code as in use a minute ago (a transcript just written). */
function hisClaudeActive(): void {
  const dir = join(tempDir, 'projects', '-Users-someone-code');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.jsonl');
  writeFileSync(file, '{}\n');
  utimesSync(file, new Date(NOW - MIN), new Date(NOW - MIN));
}

const USAGE: Usage = { weightedTokens: 6000, seconds: 2, usd: 0.05, credits: 0 };

/** A fake backend that records every complete() it gets and answers with `answer`. */
function backend(kind: 'claude' | 'ollama', answer: (i: CompleteInput) => Promise<CompleteResult> | CompleteResult = () => ({ text: '{"ok":true}', json: { ok: true }, usage: USAGE })) {
  const seen: CompleteInput[] = [];
  setProvider(kind, fakeProvider({ complete: (i) => { seen.push(i); return answer(i); } }));
  return seen;
}

function creditRows(): Array<{ kind: string; firm_id: string | null; run_id: string | null; amount: number; at: string; json: string }> {
  return openDb().prepare('SELECT kind, firm_id, run_id, amount, at, json FROM credits ORDER BY id').all() as never;
}

async function beagle(o: { voyageId?: string | null; signal?: AbortSignal; now?: number } = {}): Promise<BeagleApi> {
  const api = await loadBeagle();
  api.models.setDriver(
    schoolDriver({ voyageId: o.voyageId ?? 'voyage-1', designer: getSettings().school.designer, signal: o.signal ?? new AbortController().signal, now: () => o.now ?? NOW }),
  );
  return api;
}

const ASK = [
  { role: 'system' as const, content: 'You design agents.' },
  { role: 'user' as const, content: 'Design the next generation.' },
];

// ---------------------------------------------------------------- loading

test('loadBeagle sets BEAGLE_HOME under the temp school and throws when it points at Beagle\'s real home', async () => {
  const api = await loadBeagle();
  const want = join(paths().school, 'beagle');
  assert.equal(process.env.BEAGLE_HOME, want);
  // Beagle's store opens there, and only there.
  const file = (api.store.open().prepare('pragma database_list').all() as Array<{ name: string; file: string }>).find((d) => d.name === 'main')?.file ?? '';
  assert.ok(file.startsWith(realpathSync(want)), `Beagle's store at ${file}`);
  for (const key of ['race', 'designer', 'genome', 'stats', 'runner', 'arenas', 'models', 'store'] as const) assert.ok(api[key], key);
  assert.equal(typeof api.arenas.splitOf, 'function');
  closeBeagle();

  // A school whose beagle folder resolves to Beagle's real home (here a stand-in, under a temp HOME) is refused before Beagle opens anything.
  const fakeHome = join(tempDir, 'his-mac');
  process.env.HOME = fakeHome;
  const real = join(fakeHome, 'Library', 'Application Support', 'Beagle');
  mkdirSync(real, { recursive: true });
  rmSync(want, { recursive: true, force: true });
  symlinkSync(real, want);
  await assert.rejects(loadBeagle(), /Beagle's real home/);
  assert.deepEqual(readdirSync(real), [], 'nothing was written in his real Beagle home');

  // Anywhere else outside the school is refused too.
  const elsewhere = join(tempDir, 'elsewhere');
  mkdirSync(elsewhere);
  rmSync(want);
  symlinkSync(elsewhere, want);
  await assert.rejects(loadBeagle(), /outside the school/);
  assert.deepEqual(readdirSync(elsewhere), []);
});

test('only engine/school/beagle.ts imports Beagle, by a specifier tsc cannot follow', () => {
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|mts|mjs|js)$/.test(name) && /(from\s+|import\s*\(\s*)['"]beagle(\/|['"])/.test(readFileSync(p, 'utf8'))) offenders.push(relative(ROOT, p));
    }
  };
  for (const d of ['engine', 'shared', 'app/src', 'tools']) walk(join(ROOT, d));
  assert.deepEqual(offenders, [], 'no literal import of beagle anywhere');
  assert.match(readFileSync(join(ROOT, 'engine', 'school', 'beagle.ts'), 'utf8'), /'beagle\/' \+ /);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
  assert.match(pkg.dependencies.beagle, /\/tar\.gz\/[0-9a-f]{40}$/, 'pinned to a full commit sha, never a branch or tag');
});

test('tsc does not check Beagle\'s sources', async () => {
  const tsc = join(ROOT, 'node_modules', '.bin', 'tsc');
  const out = await new Promise<{ code: number; stdout: string }>((resolve) => {
    execFile(tsc, ['--noEmit', '-p', '.', '--listFiles'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout });
    });
  });
  assert.equal(out.code, 0, out.stdout.split('\n').filter((l) => /error/.test(l)).slice(0, 5).join('\n'));
  const files = out.stdout.split('\n').filter(Boolean);
  assert.ok(files.some((f) => f.endsWith('engine/school/beagle.ts')), 'the typecheck covers the engine');
  assert.ok(readdirSync(join(ROOT, 'node_modules', 'beagle', 'src')).length > 0, 'Beagle is installed');
  assert.deepEqual(files.filter((f) => f.includes('node_modules/beagle/')), [], 'no Beagle source in the program');
});

// ---------------------------------------------------------------- the driver

test('a designer call goes to the designer setting and is charged as school', async () => {
  reading({ five: 10 });
  const seen = backend('claude');
  const api = await beagle();
  assert.equal(getSettings().school.designer, 'claude:sonnet');
  const r = await api.models.complete(api.designer.DESIGNER, ASK, { schema: { type: 'object' } });
  assert.deepEqual(r.json, { ok: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, 'claude:sonnet', 'Beagle\'s designer is the school\'s designer setting');
  assert.equal(seen[0].system, 'You design agents.');
  assert.deepEqual(seen[0].turns, [{ role: 'user', content: 'Design the next generation.' }]);
  assert.deepEqual(seen[0].schema, { type: 'object' });
  assert.equal(seen[0].runId, 'voyage-1');
  const rows = creditRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'school');
  assert.equal(rows[0].firm_id, null);
  assert.equal(rows[0].run_id, 'voyage-1');
  assert.equal(rows[0].amount, creditsFor('claude:sonnet', USAGE));
  assert.equal(JSON.parse(rows[0].json).model, 'claude:sonnet');
  assert.equal(liveLeaseCount(), 0, 'the lease is released');

  // An agent's own model is its own.
  await api.models.complete('claude:haiku', ASK, {});
  assert.equal(seen[1].model, 'claude:haiku');
  assert.equal(seen[1].schema, null);

  // The driver loadBeagle installs reads the designer setting when it calls, and charges to no voyage.
  patchSettings({ school: { ...getSettings().school, designer: 'claude:opus' } });
  reading({ five: 10, at: Date.now() });
  const fresh = await loadBeagle();
  await fresh.models.complete(fresh.designer.DESIGNER, ASK, {});
  assert.equal(seen[2].model, 'claude:opus');
  assert.equal(seen[2].runId, null);
  assert.equal(creditRows()[2].run_id, null);
});

test('a school Claude call past claudeCreditsPerDay throws LimitError and charges nothing', async () => {
  reading({ five: 10 });
  patchSettings({ school: { ...getSettings().school, claudeCreditsPerDay: 0 } });
  const seen = backend('claude');
  const api = await beagle();
  await assert.rejects(api.models.complete('claude:sonnet', ASK, {}), (e: unknown) => e instanceof api.models.LimitError && /credits a day/.test((e as Error).message));
  assert.equal(seen.length, 0, 'no call was made');
  assert.deepEqual(creditRows(), []);
});

test('a school Claude call while he is active throws LimitError', async () => {
  reading({ five: 10 });
  hisClaudeActive();
  const seen = backend('claude');
  const api = await beagle();
  await assert.rejects(api.models.complete('claude:sonnet', ASK, {}), (e: unknown) => e instanceof api.models.LimitError && /using Claude/.test((e as Error).message));
  assert.equal(seen.length, 0);
  assert.deepEqual(creditRows(), []);
});

test('a school call during the hard stop is refused', async () => {
  reading({ five: 95 });
  const claude = backend('claude');
  const local = backend('ollama');
  const api = await beagle();
  for (const model of ['claude:sonnet', 'ollama:qwen3:30b']) {
    await assert.rejects(api.models.complete(model, ASK, {}), (e: unknown) => e instanceof api.models.LimitError && /hard stop/.test((e as Error).message), model);
  }
  assert.equal(claude.length + local.length, 0);
  assert.deepEqual(creditRows(), []);
});

test('a school call at night is charged unattended and counts in the night cap', async () => {
  reading({ five: 10, at: NIGHT });
  noteSseClients(1, NIGHT - MIN);
  backend('claude');
  const api = await beagle({ now: NIGHT });
  const before = treasury(NIGHT).night.usedPct;
  await api.models.complete('claude:sonnet', ASK, {});
  const [row] = creditRows();
  assert.equal(JSON.parse(row.json).unattended, true);
  assert.equal(Date.parse(row.at), NIGHT, 'charged on the driver\'s clock');
  assert.ok(treasury(NIGHT).night.usedPct > before, 'the night cap sees school spend');

  // By day, with him connected, the same call is attended.
  reading({ five: 10 });
  const day = await beagle();
  await day.models.complete('claude:sonnet', ASK, {});
  assert.equal(JSON.parse(creditRows()[1].json).unattended, false);
});

test('a call that fails part way is charged what it spent, and its error passes to Beagle', async () => {
  reading({ five: 10 });
  backend('ollama', () => {
    throw withSpent(new Error('ollama: the model fell over'), { weightedTokens: 0, seconds: 4, usd: 0, credits: 1.5 });
  });
  const api = await beagle();
  await assert.rejects(api.models.complete('ollama:qwen3:30b', ASK, {}), /fell over/);
  const rows = creditRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'school');
  assert.equal(rows[0].amount, 1.5);
  assert.equal(liveLeaseCount(), 0);
});

test('an aborted driver call leaves Beagle\'s race incomplete', async () => {
  reading({ five: 10 });
  const ctl = new AbortController();
  let started!: () => void;
  const callStarted = new Promise<void>((r) => (started = r));
  const seen = backend('claude', (i) => {
    started();
    return new Promise<CompleteResult>((_, reject) => {
      const stop = () => reject(withSpent(new Error('claude complete aborted'), { weightedTokens: 1200, seconds: 1, usd: 0, credits: 0 }));
      if (i.signal.aborted) stop();
      else i.signal.addEventListener('abort', stop, { once: true });
    });
  });
  const api = await beagle({ signal: ctl.signal });
  const arena: BeagleArena = {
    id: 'pal-test', data: 'pal-test', name: 'Test arena', describe: 'Answer the question.', answer: { type: 'object' },
    grade: () => 1, tools: [], show: (i) => String(i),
  };
  api.arenas.registerArena(arena);
  try {
    api.store.putArena('pal-test', 'Test arena');
    api.store.putTasks('pal-test', ['a', 'b', 'c'].map((id) => ({ id: `pal-test:${id}`, input: `q ${id}`, truth: id, split: 'race' as const })));
    const v = api.race.startVoyage('pal-test', { concurrency: 1, raceTasks: 3 });
    const g: BeagleGenome = { id: 'g1', name: 'G1', model: 'claude:sonnet', instructions: 'Answer.', tools: [], workflow: { shape: 'single' }, memory: { examples: 0 } };
    const racing = api.race.race(v.id, 1, [g], { baselines: false, signal: ctl.signal });
    await callStarted;
    ctl.abort();
    const r = await racing;
    assert.equal(r.complete, false);
    assert.equal(r.reason, 'aborted');
    assert.equal((api.store.open().prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n, 0, 'no run was scored');
    assert.equal(seen.length, 1);
    // what the cut-short call spent is still the school's
    assert.equal(creditRows().length, 1);
    assert.equal(liveLeaseCount(), 0);
  } finally {
    api.arenas.unregisterArena('pal-test');
  }
});

test('the school\'s bootstrap gives the same intervals as Beagle\'s own', async () => {
  const api = await loadBeagle();
  const xs = [0.1, 0.4, 0.35, 0.8, 0.2, 0.9, 0.05, 0.6, 0.5, 0.3];
  for (const seed of [1, 2, 7]) {
    const mine = ci(xs, seed);
    assert.deepEqual({ lo: mine.lo, hi: mine.hi }, api.stats.bootstrap(xs, seed), `seed ${seed}`);
  }
  assert.deepEqual(api.stats.bootstrap([], 1), { lo: 0, hi: 0 });
});
