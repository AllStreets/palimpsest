/**
 * The school over the engine's API and event stream (Phase 4 Task 28). Every
 * test starts its own engine on an ephemeral port with a temp home; the
 * gate's probes go to a fake runner (no pmset, ioreg or df), the trainer's
 * Python is never found (PALIMPSEST_PYTHON names a file that is not one, so
 * nothing is pinged, downloaded or trained), Ollama's host is a closed port,
 * and no route reaches the network.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { emit } from '../engine/events.js';
import { realRunner, setRunner, type Runner } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { record } from '../engine/ledger.js';
import { resetGateCache } from '../engine/school/gate.js';
import { buildSettled, resetSchoolApi, setBaseDownloader, setTrainerProbe } from '../engine/school/api.js';
import { holdTrain } from '../engine/school/trainer.js';
import { entries } from '../engine/ledger.js';
import { trainerStatus } from '../engine/school/trainer-env.js';
import { startServer, type StartedServer } from '../engine/server.js';
import { getSettings, patchSettings } from '../engine/settings.js';
import type { Graduate, Grant, Repo, SchoolSettings, TrainState, VoyageView } from '../shared/types.js';
import { constant, installNet } from './school-fixtures.js';
import { checks, makeRepo, setUp, tearDown, tempDir } from './guild-fixtures.js';

const FIX = join(import.meta.dirname, 'fixtures', 'pmset');
const fx = (name: string): string => readFileSync(join(FIX, `${name}.txt`), 'utf8');

let server: StartedServer | null = null;
let power: 'batt-ac' | 'batt-battery' = 'batt-ac';
let calls: string[] = [];

/** This Mac as the gate reads it: on power (or battery), Automatic, cool, idle an hour, with room. Anything else run is refused. */
const fakeMac: Runner = async (cmd, args) => {
  const base = cmd.split('/').pop() ?? cmd;
  calls.push(`${base} ${args.join(' ')}`.trim());
  const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });
  if (base === 'pmset' && args.join(' ') === '-g batt') return ok(fx(power));
  if (base === 'pmset' && args.join(' ') === '-g therm') return ok(fx('therm-none'));
  if (base === 'pmset' && args.join(' ') === '-g') return ok(fx('g-automatic'));
  if (base === 'ioreg') return ok('    |   "HIDIdleTime" = 3600000000000\n');
  if (base === 'df') return ok(`Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s5 971298980 636638860 292968750 68% 1 1 0% /System/Volumes/Data\n`);
  return { stdout: '', stderr: `unexpected ${base}`, code: 1 };
};

beforeEach(() => {
  setUp('school-routes');
  patchSettings({ ollamaHost: '127.0.0.1:1' });
  // A Python that is not one: trainerPython() finds none, so nothing is pinged, trained or downloaded.
  process.env.PALIMPSEST_PYTHON = join(tempDir, 'no-python');
  power = 'batt-ac';
  calls = [];
  resetGateCache();
  resetSchoolApi();
  // The trainer as a Mac without one reads it: asked of no Python at all, so nothing is pinged.
  setTrainerProbe(() => trainerStatus(null));
  setRunner(fakeMac);
});

afterEach(async () => {
  if (server) await server.close();
  server = null;
  delete process.env.PALIMPSEST_PYTHON;
  setRunner(realRunner);
  resetGateCache();
  resetSchoolApi();
  setTrainerProbe(null);
  setBaseDownloader(null);
  await tearDown();
});

async function start(): Promise<StartedServer> {
  server = await startServer({ port: 0, claudeSettingsPath: join(tempDir, 'claude-settings.json'), keychain: join(tempDir, 'none.keychain-db') });
  return server;
}

interface Answer {
  status: number;
  text: string;
  json: any;
}

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  const s = server ?? (await start());
  const h: Record<string, string> = { ...headers };
  if (method !== 'GET') h['x-palimpsest'] = '1';
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${s.port}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

function school(p: Partial<SchoolSettings>): void {
  patchSettings({ school: { ...getSettings().school, ...p } });
}

function putRepo(over: Partial<Repo>, full = 'acme/widgets'): Repo {
  const repo = makeRepo(checks({ test: 'npm test', build: 'npm run build' }), { 'README.md': 'w\n' }, full);
  const next = { ...repo, ...over };
  openDb().prepare('INSERT OR REPLACE INTO repos (full_name, json) VALUES (?, ?)').run(next.fullName, JSON.stringify(next));
  return next;
}

function putGrant(g: Partial<Grant> & Pick<Grant, 'kind' | 'repo' | 'state'>): Grant {
  const full: Grant = { at: new Date().toISOString(), by: 'him', rate: null, reason: null, acted: 0, quietUntil: null, ...g };
  openDb().prepare('INSERT OR REPLACE INTO grants (kind, repo, state, at, json) VALUES (?, ?, ?, ?, ?)').run(full.kind, full.repo, full.state, full.at, JSON.stringify(full));
  return full;
}

const voyageOf = (over: Partial<VoyageView> = {}): VoyageView => ({
  id: 'voy-1',
  arena: 'arena-1',
  status: 'sailing',
  generation: 1,
  of: 4,
  runs: { done: 10, of: 480 },
  commissionedBy: null,
  scores: [{ genome: 'g1', name: 'Bruno', generation: 1, mean: 0.5, lo: 0.4, hi: 0.6, parents: [] }],
  promoted: [],
  sealed: null,
  credits: 0,
  startedAt: '2026-11-12T01:00:00.000Z',
  endedAt: null,
  repo: 'acme/widgets',
  reason: null,
  pausedAt: null,
  ...over,
});

function putVoyage(v: VoyageView): void {
  openDb().prepare('INSERT OR REPLACE INTO voyages (id, json) VALUES (?, ?)').run(v.id, JSON.stringify(v));
}

// ------------------------------------------------------------------ the school whole

test('on an empty home the school view has seven thin cards each with a cause, no arena, lora 0 of 100 and the trainer not set up', async () => {
  const r = await call('GET', '/api/school');
  assert.equal(r.status, 200);
  const v = r.json;
  assert.equal(v.nets.length, 7, 'seven nets');
  for (const card of v.nets) {
    assert.equal(card.status, 'thin', `${card.net} is thin`);
    assert.ok(typeof card.cause === 'string' && card.cause.length > 0, `${card.net} names its cause`);
    assert.equal(card.current, null);
  }
  assert.deepEqual(v.arenas, [], 'no arena');
  assert.deepEqual(v.voyages, []);
  assert.deepEqual(v.graduates, []);
  assert.deepEqual(v.grants, []);
  assert.deepEqual(v.grantAgreements, [], 'no pair, no repo agreement');
  assert.deepEqual(v.trains, []);
  assert.equal(v.lora.examples, 0);
  assert.equal(v.lora.needs, 100);
  assert.deepEqual(v.lora.counts, {});
  assert.equal(v.lora.baseReady, false);
  assert.equal(v.trainer.ready, false);
  assert.equal(v.trainer.reason, 'The trainer is not set up on this Mac');
  assert.ok(!('python' in v.trainer), 'the trainer never names its Python');
  assert.equal(v.settings.enabled, false);
  assert.equal(v.gate.light.kind, 'light');
  assert.equal(v.gate.heavy.kind, 'heavy');
  assert.equal(v.gate.heavy.reason, 'the school is off');
  assert.ok(Array.isArray(v.agreements) && v.agreements.length === 6, 'an agreement per kind');
  assert.ok(!calls.some((c) => /python|ollama|mlx/.test(c)), `nothing but the gate's probes ran (${calls.join(', ')})`);
});

test('the school view and its pages: a net, a voyage (a queued commission says so), a graduate', async () => {
  installNet(constant('master', 2, 0.7), { trusted: true });
  putVoyage(voyageOf());
  putVoyage(voyageOf({ id: 'voy-q', status: 'paused', generation: 0, scores: [], commissionedBy: 'quickset', startedAt: '2026-11-12T02:00:00.000Z', reason: 'It sails first tonight.' }));
  const g: Graduate = {
    id: 'grad-qwen25c7-1',
    model: 'mlx:grad-qwen25c7-1',
    base: 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit',
    loraId: 'lora-1',
    sealed: { value: 0.61, lo: 0.52, hi: 0.7, n: 20 },
    baseSealed: { value: 0.47, lo: 0.38, hi: 0.56, n: 20 },
    vsBase: { diff: 0.14, lo: 0.06, hi: 0.22 },
    examples: 112,
    arenas: [],
    at: '2026-11-12T04:00:00.000Z',
    agentId: null,
  };
  openDb().prepare('INSERT OR REPLACE INTO graduates (id, json) VALUES (?, ?)').run(g.id, JSON.stringify(g));

  const all = (await call('GET', '/api/school')).json;
  const queued = all.voyages.find((x: VoyageView & { queued?: boolean }) => x.id === 'voy-q');
  assert.equal(queued.queued, true, 'a commission not yet sailed is queued');
  assert.equal(all.voyages.find((x: { id: string }) => x.id === 'voy-1').queued, false);
  const master = all.nets.find((n: { net: string }) => n.net === 'master');
  assert.equal(master.current.version, 2);
  assert.ok(!('path' in master.current), 'a net card never names its weights');

  const net = await call('GET', '/api/school/nets/master');
  assert.equal(net.status, 200);
  assert.equal(net.json.net, 'master');
  assert.equal(net.json.versions.length, 1);
  assert.ok(!('path' in net.json.versions[0]));
  assert.equal((await call('GET', '/api/school/nets/nonesuch')).status, 404);

  const voy = await call('GET', '/api/school/voyages/voy-q');
  assert.equal(voy.status, 200);
  assert.equal(voy.json.queued, true);
  assert.equal((await call('GET', '/api/school/voyages/voy-nope')).status, 404);
  assert.ok([400, 404].includes((await call('GET', '/api/school/voyages/..%2Fx')).status), 'a path-shaped id is refused');
  assert.equal((await call('GET', '/api/school/voyages/-x')).status, 400);

  const grad = await call('GET', '/api/school/graduates/grad-qwen25c7-1');
  assert.equal(grad.status, 200);
  assert.equal(grad.json.vsBase.diff, 0.14);
  assert.equal((await call('GET', '/api/school/graduates/grad-nope')).status, 404);
});

// ------------------------------------------------------------------ his moves

test('building an arena on a market-off repo is 409 with the reason', async () => {
  school({ enabled: true });
  putRepo({ market: false });
  const r = await call('POST', '/api/school/arenas/acme/widgets', { kind: 'planted' });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /market is off on acme\/widgets/);
  putRepo({ market: true, checks: checks({ test: null }) }, 'acme/notests');
  const nt = await call('POST', '/api/school/arenas/acme/notests', { kind: 'past' });
  assert.equal(nt.status, 409);
  assert.match(nt.json.error, /no test command/);
  assert.equal((await call('POST', '/api/school/arenas/acme/widgets', { kind: 'huge' })).status, 400, 'the kind is planted or past');
  assert.equal((await call('POST', '/api/school/arenas/acme/unknown', { kind: 'planted' })).status, 404);
  assert.ok([400, 404].includes((await call('POST', '/api/school/arenas/..%2F/x', { kind: 'planted' })).status), 'a path-shaped repo is refused');
  const s = server!;
  const bare = await fetch(`http://127.0.0.1:${s.port}/api/school/arenas/acme/widgets`, { method: 'POST', body: JSON.stringify({ kind: 'planted' }) });
  assert.equal(bare.status, 403, 'a write needs the header');
});

test('grant without an ask is 409, and from Settings on a revoked pair is 200', async () => {
  putRepo({});
  const path = (move: string) => `/api/autonomy/${encodeURIComponent('merge:low')}/acme/widgets/${move}`;
  const none = await call('POST', path('grant'));
  assert.equal(none.status, 409);
  assert.match(none.json.error, /was not asked/);
  putGrant({ kind: 'merge:low', repo: 'acme/widgets', state: 'revoked', quietUntil: '2026-12-12T00:00:00.000Z' });
  const plain = await call('POST', path('grant'));
  assert.equal(plain.status, 409, 'a revoked pair is granted again only from Settings');
  assert.match(plain.json.error, /Grant it again from Settings/);
  const again = await call('POST', path('grant'), { fromSettings: true });
  assert.equal(again.status, 200);
  assert.equal(again.json.state, 'granted');
  const revoked = await call('POST', path('revoke'));
  assert.equal(revoked.status, 200);
  assert.equal(revoked.json.state, 'revoked');
  assert.equal(revoked.json.by, 'him');
  assert.equal((await call('POST', path('decline'))).status, 409, 'nothing open to decline');
  putGrant({ kind: 'propose:harness', repo: 'acme/widgets', state: 'asked', by: 'school' });
  const declined = await call('POST', `/api/autonomy/propose:harness/acme/widgets/decline`);
  assert.equal(declined.status, 200);
  assert.equal(declined.json.state, 'declined');
  assert.equal((await call('POST', `/api/autonomy/merge:huge/acme/widgets/grant`)).status, 400, 'an unknown kind');
  assert.equal((await call('POST', path('grant'), { fromSettings: 'yes' })).status, 400);
});

test("the view carries each grant's own repo agreement", async () => {
  putRepo({});
  putGrant({ kind: 'merge:low', repo: 'acme/widgets', state: 'granted' });
  putGrant({ kind: 'propose:harness', repo: 'acme/widgets', state: 'asked', by: 'school' });
  const v = (await call('GET', '/api/school')).json as { grants: Grant[]; grantAgreements: Array<{ kind: string; repo: string | null; repoRows?: number; repoAgreed?: number }> };
  assert.equal(v.grantAgreements.length, v.grants.length, 'one per grant');
  for (const [i, g] of v.grants.entries()) {
    const a = v.grantAgreements[i];
    assert.equal(a.kind, g.kind);
    assert.equal(a.repo, g.repo, 'for the pair’s own repo, not pooled');
    assert.equal(a.repoRows, 0);
    assert.equal(a.repoAgreed, 0);
  }
});

test('train-now on battery is 409', async () => {
  power = 'batt-battery';
  const r = await call('POST', '/api/school/train-now');
  assert.equal(r.status, 409);
  assert.equal(r.json.error, 'on battery');
  assert.equal(getSettings().school.trainNowUntil, null);
  power = 'batt-ac';
  resetGateCache();
  const ok = await call('POST', '/api/school/train-now');
  assert.equal(ok.status, 200);
  assert.ok(Date.parse(ok.json.until) > Date.now());
  assert.equal(getSettings().school.trainNowUntil, ok.json.until);
  const off = await call('DELETE', '/api/school/train-now');
  assert.equal(off.status, 200);
  assert.equal(getSettings().school.trainNowUntil, null);
});

test('download-base answers 202 on his click and is the only caller of downloadBase', async () => {
  const r = await call('POST', '/api/school/download-base');
  assert.equal(r.status, 202);
  const s = server!;
  const bare = await fetch(`http://127.0.0.1:${s.port}/api/school/download-base`, { method: 'POST' });
  assert.equal(bare.status, 403, 'a write needs the header');
  // The trainer is not set up here, so it fails at once without a process; the school view says why.
  let lora: any = null;
  for (let i = 0; i < 200; i++) {
    lora = (await call('GET', '/api/school')).json.lora;
    if (lora.download && !lora.download.running) break;
    await new Promise((res) => setTimeout(res, 10));
  }
  assert.equal(lora.download.running, false);
  assert.equal(lora.download.reason, 'The trainer is not set up on this Mac');
  assert.ok(!calls.some((c) => /python|school\.py/.test(c)), 'no Python ran');

  // Nothing else in the engine calls downloadBase: the click is the only way the base comes down.
  const callers: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.ts') && /\bdownloadBase\(/.test(readFileSync(p, 'utf8').replace(/export function downloadBase\(/, ''))) callers.push(p.slice(p.indexOf('engine')));
    }
  };
  walk(join(import.meta.dirname, '..', 'engine'));
  assert.deepEqual(callers, ['engine/school/api.ts']);
});

test('settings refuse idleMinutes 2 and a malformed designer without running ollama', async () => {
  const bad = [
    { school: { idleMinutes: 2 } },
    { school: { idleMinutes: 121 } },
    { school: { designer: 'gpt-4' } },
    { school: { designer: 'ollama:../../x' } },
    { school: { window: { from: '25:00', to: '06:00' } } },
    { school: { window: '01:00' } },
    { school: { claudeCreditsPerDay: 101 } },
    { school: { enabled: 'yes' } },
    { school: { baseModelReady: true } },
    { school: { trainNowUntil: '2099-01-01T00:00:00.000Z' } },
    { school: { nonesuch: 1 } },
    { school: null },
  ];
  for (const body of bad) {
    const r = await call('PATCH', '/api/settings', body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const ok = await call('PATCH', '/api/settings', { school: { enabled: true, idleMinutes: 30, designer: 'ollama:qwen2.5-coder:14b', window: { from: '22:00', to: '04:00' }, allowLowPower: true, claudeCreditsPerDay: 0, understudy: false, commitsAsWork: false } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.school.idleMinutes, 30);
  assert.equal(ok.json.school.designer, 'ollama:qwen2.5-coder:14b');
  assert.deepEqual(ok.json.school.window, { from: '22:00', to: '04:00' });
  assert.equal(ok.json.school.enabled, true);
  assert.equal(ok.json.school.baseModel, 'mlx-community/Qwen2.5-Coder-7B-Instruct-4bit', 'what the patch leaves out stays');
  const partial = await call('PATCH', '/api/settings', { school: { idleMinutes: 5 } });
  assert.equal(partial.json.school.designer, 'ollama:qwen2.5-coder:14b', 'a partial patch keeps the rest');
  assert.ok(!calls.some((c) => /ollama/.test(c)), 'no ollama list');
});

test('a refused school setting says why in words he can act on (Task 32)', async () => {
  const said = async (school: unknown) => {
    const r = await call('PATCH', '/api/settings', { school });
    assert.equal(r.status, 400, JSON.stringify(school));
    return r.json.error as string;
  };
  assert.equal(await said({ window: { from: '25:00', to: '06:00' } }), '25:00 is not a time of day: say it as hours and minutes, 00:00 to 23:59.');
  assert.equal(await said({ window: { from: '01:00', to: '01:00' } }), 'The window starts and ends at the same time; give it some hours.');
  assert.equal(await said({ idleMinutes: 2 }), 'The idle wait is a whole number of minutes, 5 to 120.');
  assert.equal(await said({ claudeCreditsPerDay: 101 }), 'The school may spend a whole number of credits a day, 0 to 100.');
  assert.equal(await said({ designer: 'gpt-4' }), 'Name a model as ollama:<name> or claude:<name>.');
  assert.equal(await said({ enabled: 'yes' }), 'Run the school is either on or off.');
  assert.equal(await said({ baseModelReady: true }), 'baseModelReady is set by the school itself, not from Settings.');
  // Nothing refused was kept.
  assert.deepEqual(getSettings().school.window, { from: '01:00', to: '06:00' });
  assert.equal(getSettings().school.idleMinutes, 15);
  // A refusal outside the school keeps the plain answer.
  assert.equal((await call('PATCH', '/api/settings', { dayCapPct: 900 })).json.error, 'invalid settings patch');
});

test('the download goes through the stand-in a test installs: 202, then the view says ready', async () => {
  let release!: () => void;
  const done = new Promise<void>((res) => (release = res));
  setBaseDownloader(async () => {
    await done;
    patchSettings({ school: { ...getSettings().school, baseModelReady: true } });
    const base = join(paths().school, 'lora', 'base');
    (await import('node:fs')).mkdirSync(base, { recursive: true });
    writeFileSync(join(base, 'config.json'), '{}\n');
    return { status: 'ready', reason: null };
  });
  const r = await call('POST', '/api/school/download-base');
  assert.equal(r.status, 202);
  assert.equal((await call('GET', '/api/school')).json.lora.download.running, true);
  assert.equal((await call('POST', '/api/school/download-base')).status, 202, 'a second click waits on the same download');
  release();
  let lora: any = null;
  for (let i = 0; i < 200; i++) {
    lora = (await call('GET', '/api/school')).json.lora;
    if (!lora.download.running) break;
    await new Promise((res) => setTimeout(res, 10));
  }
  assert.equal(lora.baseReady, true);
  assert.equal(lora.download.status, 'ready');
  assert.equal((await call('POST', '/api/school/download-base')).status, 200, 'once the base is there the click answers ready');
  assert.ok(!calls.some((c) => /python|school\.py/.test(c)), 'no Python ran');
});

test("the treasury counts the week's training and opens the school's and training's credits by kind", async () => {
  const { charge } = await import('../engine/market/budget.js');
  const now = Date.now();
  const put = (t: TrainState) => openDb().prepare('INSERT OR REPLACE INTO trains (id, kind, status, json) VALUES (?, ?, ?, ?)').run(t.id, t.kind, t.status, JSON.stringify(t));
  const iso = (ms: number) => new Date(ms).toISOString();
  put({ id: 't-old', kind: 'nets', status: 'done', reason: null, startedAt: iso(now - 9 * 86_400_000), endedAt: iso(now - 9 * 86_400_000 + 3_600_000), seconds: 3600, steps: null, credits: 1 });
  put({ id: 't-nets', kind: 'nets', status: 'done', reason: null, startedAt: iso(now - 86_400_000), endedAt: iso(now - 86_400_000 + 720_000), seconds: 720, steps: null, credits: 1 });
  put({ id: 't-lora', kind: 'lora', status: 'paused', reason: 'on battery', startedAt: iso(now - 2 * 86_400_000), endedAt: iso(now - 2 * 86_400_000 + 3 * 3_600_000), seconds: 3 * 3600, steps: null, credits: 4 });
  put({ id: 't-run', kind: 'voyage', status: 'running', reason: null, startedAt: iso(now - 600_000), endedAt: null, seconds: 0, steps: null, credits: 0 });
  const t = (await call('GET', '/api/treasury')).json;
  assert.equal(t.school.enabled, false);
  // 12 minutes, 3 hours and the running 10 minutes; the train nine days ago is outside the week.
  assert.ok(Math.abs(t.school.trainedSeconds - (720 + 3 * 3600 + 600)) <= 2, String(t.school.trainedSeconds));

  charge({ runId: 'v-1', firmId: null, model: 'ollama:qwen2.5-coder:7b', kind: 'school', usage: { weightedTokens: 0, seconds: 600, usd: 0, credits: 3 }, unattended: true, at: now - 60_000 });
  charge({ runId: 't-nets', firmId: null, model: 'mlx:nets', kind: 'train', usage: { weightedTokens: 0, seconds: 720, usd: 0, credits: 1 }, unattended: true, at: now - 120_000 });
  const v = (await call('GET', '/api/treasury')).json;
  assert.deepEqual(v.spend.week.city.map((k: { kind: string }) => k.kind), ['school', 'train']);
  const school = (await call('GET', '/api/treasury/credits?period=week&firm=~city&kind=school')).json;
  assert.deepEqual(school.rows.map((r: { runId: string }) => r.runId), ['v-1']);
  assert.equal((await call('GET', '/api/treasury/credits?period=week&kind=nonesuch')).status, 400);
});

test('AgentDetail.school for the sample graduate carries its graduate row (Task 33)', async () => {
  const { SAMPLE_GRADUATE } = await import('../engine/market/sample-economy.js');
  const { hireSeed, seedFirms } = await import('../engine/market/firms.js');
  const { schoolRoster } = await import('../engine/school/roster.js');
  seedFirms(['qwen2.5-coder:7b', 'qwen3-coder:30b-a3b-q4_K_M', 'gpt-oss:20b', 'llama3.1:8b']);
  const g: Graduate = { ...SAMPLE_GRADUATE, at: new Date().toISOString() };
  openDb().prepare('INSERT OR REPLACE INTO graduates (id, json) VALUES (?, ?)').run(g.id, JSON.stringify(g));
  openDb().prepare('INSERT OR REPLACE INTO arenas (id, repo, json) VALUES (?, ?, ?)').run(g.arenas[0], 'tidewater/harbor-ledger', JSON.stringify({ id: g.arenas[0], repo: 'tidewater/harbor-ledger', kind: 'planted', sha: 'a'.repeat(40), tasks: { breeding: 18, race: 15, sealed: 15 }, candidates: 60, kept: 48, sealedUses: 3, sealedHash: null, builtAt: new Date().toISOString(), status: 'ready', reason: null }));
  const seed = schoolRoster().find((x) => x.id === g.id);
  assert.ok(seed, 'the graduate is on the school roster');
  const hired = hireSeed('ashlar-vane', seed!);
  assert.ok(hired, 'Ashlar & Vane hires it');
  const d = (await call('GET', `/api/agents/${g.id}`)).json;
  assert.equal(d.school.voyage, null);
  assert.equal(d.school.graduate.id, g.id);
  assert.equal(d.school.graduate.base, g.base);
  assert.equal(d.school.graduate.loraId, 'lora-7a2c91e4');
  assert.deepEqual(d.school.graduate.vsBase, g.vsBase);
  assert.equal(d.school.graduate.examples, 112);
  assert.equal(d.school.graduate.agentId, g.id);
  assert.deepEqual(d.school.arenas.map((a: { id: string; repo: string }) => [a.id, a.repo]), [[g.arenas[0], 'tidewater/harbor-ledger']]);
  // A seeded agent's page carries no school.
  const seeded = (await call('GET', '/api/firms')).json.flatMap((f: { agents: Array<{ id: string; lineage: { origin: string } }> }) => f.agents).find((a: { lineage: { origin: string } }) => a.lineage.origin === 'seeded');
  const sd = (await call('GET', `/api/agents/${seeded.id}`)).json;
  assert.deepEqual(sd.school, { voyage: null, graduate: null, arenas: [] });
});

test("AgentDetail.school for a bred specialist carries its voyage without the genome's body (Task 33)", async () => {
  const { hireSeed, seedFirms } = await import('../engine/market/firms.js');
  const { bredId, schoolRoster } = await import('../engine/school/roster.js');
  seedFirms(['qwen2.5-coder:7b', 'qwen3-coder:30b-a3b-q4_K_M', 'gpt-oss:20b', 'llama3.1:8b']);
  const locals = (await call('GET', '/api/firms')).json.flatMap((f: { agents: Array<{ id: string; model: string }> }) => f.agents).filter((a: { model: string }) => a.model.startsWith('ollama:')).slice(0, 2);
  assert.equal(locals.length, 2);
  const body = { id: 'g2-1', name: 'Harbour 2.1', model: 'ollama:qwen2.5-coder:7b', instructions: 'Fix the bug.\n', tools: ['read', 'edit'], workflow: { shape: 'single' }, memory: { examples: 2 } };
  const v: VoyageView = {
    id: 'v-bred-1', arena: 'arena-x', status: 'done', generation: 2, of: 2, runs: { done: 10, of: 10 }, commissionedBy: 'quickset',
    scores: [
      ...locals.map((a: { id: string }) => ({ genome: a.id, name: a.id, generation: 1, mean: 0.4, lo: 0.3, hi: 0.5, parents: [] })),
      { genome: 'g2-1', name: 'Harbour 2.1', generation: 2, mean: 0.6, lo: 0.5, hi: 0.7, parents: locals.map((a: { id: string }) => a.id) },
    ],
    promoted: [], sealed: { value: 0.58, lo: 0.46, hi: 0.7, n: 15 }, credits: 3, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    champion: { genome: 'g2-1', name: 'Harbour 2.1', model: 'ollama:qwen2.5-coder:7b', generation: 2, parents: locals.map((a: { id: string }) => a.id), body: body as never },
    vsLocal: locals.map((a: { id: string }) => ({ agent: a.id, name: a.id, diff: 0.2, lo: 0.1, hi: 0.3 })), claim: true,
  };
  openDb().prepare('INSERT INTO voyages (id, json) VALUES (?, ?)').run(v.id, JSON.stringify(v));
  const seed = schoolRoster().find((x) => x.id === bredId('g2-1'))!;
  const a = hireSeed('kiln', seed) ?? hireSeed('sparrow', seed) ?? hireSeed('meridian', seed);
  assert.ok(a, 'a firm hires the champion');
  const d = (await call('GET', `/api/agents/${a!.id}`)).json;
  assert.equal(d.school.graduate, null);
  assert.equal(d.school.voyage.id, 'v-bred-1');
  assert.equal(d.school.voyage.commissionedBy, 'quickset');
  assert.equal(d.school.voyage.champion.body, undefined, 'the genome is never served');
  assert.deepEqual(d.lineage.parents.map((p: { id: string }) => p.id).sort(), locals.map((x: { id: string }) => x.id).sort());
});

// ------------------------------------------------------------------ redaction

test('no view carries a path of this Mac', async () => {
  const mac = homedir();
  const data = paths().school;
  const repo = putRepo({});
  installNet(constant('appraiser-pass', 1, 0.6), { trusted: false });
  installNet(constant('master', 3, 0.7), { trusted: true });
  putVoyage(voyageOf({ reason: `paused: ${mac}/Library/x.json`, champion: { genome: 'g1', name: 'Bruno', model: 'ollama:qwen', generation: 1, parents: [], body: { id: 'g1', instructions: `${data}/arenas/task-body.md` } as never } }));
  const train: TrainState = { id: 'train-1', kind: 'lora', status: 'running', reason: `${data}/lora/train.jsonl`, startedAt: '2026-11-12T01:00:00.000Z', endedAt: null, seconds: 0, steps: { done: 1, of: 600, lost: 0, optimizerReset: false }, credits: 0 };
  openDb().prepare('INSERT OR REPLACE INTO trains (id, kind, status, json) VALUES (?, ?, ?, ?)').run(train.id, train.kind, train.status, JSON.stringify(train));
  openDb()
    .prepare('INSERT OR REPLACE INTO arenas (id, repo, json) VALUES (?, ?, ?)')
    .run('arena-1', repo.fullName, JSON.stringify({ id: 'arena-1', repo: repo.fullName, kind: 'planted', sha: 'a'.repeat(40), tasks: { breeding: 1, race: 1, sealed: 1 }, candidates: 3, kept: 3, sealedUses: 0, sealedHash: null, builtAt: '2026-11-12T00:00:00.000Z', status: 'ready', reason: `rows at ${data}/arenas/arena-1/rows.jsonl` }));
  putGrant({ kind: 'merge:low', repo: repo.fullName, state: 'suspended', reason: `the shot at ${mac}/Library/Application Support/Understudy/shots/1.png` });
  writeFileSync(join(data, 'lora', 'train.jsonl'), '{"messages":[]}\n');
  record('train.started', { train, voyageId: null });

  const views = [
    await call('GET', '/api/school'),
    await call('GET', '/api/school/nets/master'),
    await call('GET', '/api/school/nets/appraiser-pass'),
    await call('GET', '/api/school/voyages/voy-1'),
    await call('GET', '/api/school/campus'),
  ];
  for (const v of views) {
    assert.equal(v.status, 200);
    for (const bad of [mac, data, tempDir, 'train.jsonl', 'rows.jsonl', 'task-body', '/shots/', 'no-python', '"path"', '"python"']) {
      assert.ok(!v.text.includes(bad), `a view carries ${bad}: ${v.text.slice(0, 200)}`);
    }
  }
  assert.ok(!('body' in (views[3].json.champion ?? {})), "a champion's genome body is never served");
});

test('SSE forwards net.trained and autonomy.acted scrubbed', async () => {
  const s = await start();
  const text = await new Promise<string>((resolve, reject) => {
    let armed = false;
    const req = httpRequest({ host: '127.0.0.1', port: s.port, path: '/api/events', headers: { host: `127.0.0.1:${s.port}` } }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        t += c;
        if (!armed && t.includes(': connected')) {
          armed = true;
          emit('net.trained', { net: 'master', version: 4, trusted: true, path: `${paths().school}/nets/master/v4.json` });
          emit('autonomy.acted', { kind: 'merge:low', repo: 'acme/widgets', jobId: 'job-1', note: `merged from ${homedir()}/x`, token: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
        }
        if (t.includes('event: autonomy.acted')) {
          req.destroy();
          resolve(t);
        }
      });
    });
    req.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e);
    });
    req.end();
    setTimeout(() => {
      req.destroy();
      reject(new Error('timed out waiting for the event'));
    }, 30_000).unref();
  });
  assert.match(text, /event: net\.trained\ndata: \{"net":"master","version":4,"trusted":true/);
  assert.ok(text.includes('event: autonomy.acted\n'));
  assert.ok(!text.includes(homedir()), 'no home path');
  assert.ok(!text.includes(paths().school), 'no school path');
  assert.ok(!text.includes('ghp_abcdefgh'), 'no token');
});

// ------------------------------------------------------------------ the campus

test('GET /api/school/campus fills live from the trains running', async () => {
  const put = (id: string, kind: TrainState['kind'], status: TrainState['status']): void => {
    const t: TrainState = { id, kind, status, reason: null, startedAt: '2026-11-12T01:00:00.000Z', endedAt: null, seconds: 0, steps: null, credits: 0 };
    openDb().prepare('INSERT OR REPLACE INTO trains (id, kind, status, json) VALUES (?, ?, ?, ?)').run(id, kind, status, JSON.stringify(t));
  };
  let c = (await call('GET', '/api/school/campus')).json;
  assert.deepEqual(c.live, { voyage: false, nets: false, lora: false });
  put('t-n', 'nets', 'running');
  put('t-l', 'lora', 'paused');
  c = (await call('GET', '/api/school/campus')).json;
  assert.deepEqual(c.live, { voyage: false, nets: true, lora: false }, 'a paused LoRA is not under way');
  put('t-l2', 'lora', 'running');
  put('t-n', 'nets', 'done');
  putVoyage(voyageOf());
  c = (await call('GET', '/api/school/campus')).json;
  assert.deepEqual(c.live, { voyage: true, nets: false, lora: true });
});

test('an arena build the engine refuses as it starts is recorded, emitted and shown with its reason', async () => {
  school({ enabled: true });
  putRepo({});
  // A graduation's sealed race holds the machine: the build refuses as it starts, after the route answered 202.
  const evalTrain: TrainState = { id: 'train-eval', kind: 'eval', status: 'running', reason: null, startedAt: new Date().toISOString(), endedAt: null, seconds: 0, steps: null, credits: 0 };
  const release = holdTrain(evalTrain, () => {});
  const heard: unknown[] = [];
  const { subscribe } = await import('../engine/events.js');
  const stop = subscribe((e) => {
    if (e.type === 'arena.refused') heard.push(e.data);
  });
  try {
    const r = await call('POST', '/api/school/arenas/acme/widgets', { kind: 'planted' });
    assert.equal(r.status, 202);
    await buildSettled();
  } finally {
    release();
    stop();
  }
  const rec = entries().filter((e) => e.kind === 'arena.refused');
  assert.equal(rec.length, 1);
  assert.deepEqual({ ...(rec[0].data as object), at: undefined }, { repo: 'acme/widgets', kind: 'planted', reason: 'A graduation race is running; build the arena once it ends', at: undefined });
  assert.equal(heard.length, 1, 'emitted for the page');
  const v = (await call('GET', '/api/school')).json;
  assert.equal(v.arenaRefusals.length, 1);
  assert.equal(v.arenaRefusals[0].reason, 'A graduation race is running; build the arena once it ends');
  assert.deepEqual(v.arenas, [], 'nothing was built');
});

test("SSE scrubs the school's events: a voyage's champion body and any path never leave", async () => {
  const s = await start();
  const text = await new Promise<string>((resolve, reject) => {
    let armed = false;
    const req = httpRequest({ host: '127.0.0.1', port: s.port, path: '/api/events', headers: { host: `127.0.0.1:${s.port}` } }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => {
        t += c;
        if (!armed && t.includes(': connected')) {
          armed = true;
          const v = voyageOf({ champion: { genome: 'g1', name: 'Bruno', model: 'ollama:qwen', generation: 1, parents: [], body: { id: 'g1', instructions: 'SECRET-GENOME-INSTRUCTIONS' } as never } });
          emit('voyage.generation', { voyageId: v.id, voyage: v, repo: 'acme/widgets' });
          emit('arena.refused', { repo: 'acme/widgets', kind: 'past', reason: `rows at ${paths().school}/arenas/a/rows.jsonl`, at: 'x' });
          // the master's guess, his decision and the switch are the school's too: a body or a file key never goes
          emit('master.predicted', { key: 'merge:normal:job-1', p: 0.9, body: 'SECRET-PREDICTED-BODY' });
          emit('decision.resolved', { key: 'merge:normal:job-1', by: 'merge', file: 'SECRET-DECIDED-FILE' });
          emit('school.enabled', { on: false, path: 'SECRET-SWITCH-PATH' });
          emit('train.paused', { train: { id: 't', kind: 'lora' }, reason: `${homedir()}/Library/Application Support/Palimpsest/school/lora/train.jsonl`, lost: 0 });
        }
        if (t.includes('event: train.paused')) {
          req.destroy();
          resolve(t);
        }
      });
    });
    req.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e);
    });
    req.end();
    setTimeout(() => {
      req.destroy();
      reject(new Error('timed out waiting for the event'));
    }, 30_000).unref();
  });
  assert.ok(text.includes('event: voyage.generation\n'));
  assert.ok(text.includes('"champion":{"genome":"g1"'), 'the champion itself still goes');
  for (const type of ['master.predicted', 'decision.resolved', 'school.enabled']) assert.ok(text.includes(`event: ${type}\n`), `${type} went out`);
  for (const bad of ['SECRET-GENOME', '"body"', 'rows.jsonl', 'train.jsonl', homedir(), paths().school, 'SECRET-PREDICTED-BODY', 'SECRET-DECIDED-FILE', 'SECRET-SWITCH-PATH']) assert.ok(!text.includes(bad), `the stream carries ${bad}`);
});
