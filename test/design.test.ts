/**
 * The design check (Task 15): before and after screenshots (ruling 24), the
 * diff-only judge when nothing can render (ruling 13), the judge's lease
 * and the screenshotter's request filter. Commands go through a fake
 * spawner, Playwright is replaced by an injected screenshotter, every model
 * is the fake provider. One opt-in-free check runs the real headless
 * Chromium against a static page this test serves on a port-0 loopback
 * server, and is skipped where Chromium cannot start.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import { openDb } from '../engine/db.js';
import { setSpawner, type SpawnLine, type Spawned } from '../engine/exec.js';
import { paths } from '../engine/home.js';
import { inspect } from '../engine/guild/inspect.js';
import { allowShotRequest, judgeDesign, playwrightScreenshotter, UI_FILES, type BrowserLike, type Screenshotter } from '../engine/guild/design.js';
import { abortLease, liveLeaseCount, type Lease } from '../engine/market/budget.js';
import { fakeProvider } from '../engine/market/fake-provider.js';
import type { JudgeInput } from '../engine/market/provider.js';
import { setProvider } from '../engine/market/providers.js';
import type { RunLogLine } from '../engine/market/provider.js';
import { addAgent, checks, makeRepo, makeRun, PNG, postJob, setUp, tearDown, workLease, write } from './guild-fixtures.js';

let judged: JudgeInput[] = [];
let commands: string[] = [];
let shots: Array<{ side: string; routes: string[]; port: number; outDir: string }> = [];
const SERVED_PORT = 43_210;

/** A child that prints `out` and exits 0, or (for the static server) prints its port and runs until killed. */
function fakeChild(command: string): Spawned {
  let finish!: (d: { code: number | null; signal: string | null }) => void;
  const done = new Promise<{ code: number | null; signal: string | null }>((r) => (finish = r));
  const serving = command.includes('static-server.mjs');
  const shot = /PALIMPSEST_SHOT='([^']+)'/.exec(command);
  if (shot) {
    mkdirSync(dirname(shot[1]), { recursive: true });
    writeFileSync(shot[1], PNG);
  }
  const lines: SpawnLine[] = serving ? [{ stream: 'stdout', line: `PALIMPSEST_SERVING ${SERVED_PORT}` }] : [];
  if (!serving) setTimeout(() => finish({ code: 0, signal: null }), 0);
  return {
    pid: null,
    lines: (async function* () {
      for (const l of lines) yield l;
      await done;
    })(),
    kill() {
      finish({ code: null, signal: 'SIGTERM' });
    },
    done,
  };
}

const screenshotter: Screenshotter = async (o) => {
  shots.push({ side: o.side, routes: o.routes, port: o.port, outDir: o.outDir });
  mkdirSync(o.outDir, { recursive: true });
  return o.routes.map((route, i) => {
    const path = join(o.outDir, `${o.side}-${i}.png`);
    writeFileSync(path, PNG);
    return { route, path };
  });
};

beforeEach(() => {
  setUp('design');
  judged = [];
  commands = [];
  shots = [];
  const p = fakeProvider({
    judge: (i) => {
      judged.push(i);
      return { before: i.before.length ? 6 : null, after: 7, notes: 'Calm.', usage: { weightedTokens: 500, seconds: 3, usd: 0, credits: 0.5 } };
    },
  });
  setProvider('claude', p);
  setProvider('ollama', p);
  setSpawner((cmd, args) => {
    const command = args.at(-1) ?? cmd;
    commands.push(command);
    return fakeChild(command);
  });
});
afterEach(tearDown);

function team() {
  return { worker: addAgent('wanda', 'alpha', 'claude:sonnet'), reviewer: addAgent('rex', 'beta', 'claude:sonnet') };
}

test('a UI diff on a static repo is shot before and after at each route', { timeout: 60_000 }, async () => {
  const repo = makeRepo(checks({ preview: { kind: 'static', outDir: '.' }, shots: ['/', '/about'] }), {
    'index.html': '<h1>Widgets</h1>\n',
    'style.css': 'h1 { color: black; }\n',
  });
  const { worker } = team();
  const job = postJob(['**']);
  const { run, diff } = await makeRun(repo, job, worker, (dir) => write(dir, 'style.css', 'h1 { color: navy; }\n'));
  const lease = await workLease();
  try {
    const insp = await inspect(run, job, repo, diff, lease, { screenshotter });
    // Both sides, every route, against the port the static server reported.
    // The head first (from the engine's fresh clone), then the base once the run's scratch dirs are wiped.
    assert.deepEqual(shots.map((s) => [s.side, s.routes, s.port]), [
      ['after', ['/', '/about'], SERVED_PORT],
      ['before', ['/', '/about'], SERVED_PORT],
    ]);
    const root = join(paths().runs, run.id);
    for (const s of shots) assert.ok(s.outDir.startsWith(join(root, 'inspection')), 'shots are kept with the inspection');
    // The base side was a checkout of the base sha made by the engine.
    assert.ok(existsSync(join(root, 'base', 'index.html')));
    assert.equal(commands.filter((c) => c.includes('static-server.mjs')).length, 2);
    assert.ok(commands.some((c) => c.includes('static-server.mjs') && c.includes(join(root, 'base'))), 'the base side is served from <runRoot>/base');
    assert.ok(commands.some((c) => c.includes('static-server.mjs') && c.includes(join(root, 'ship'))), 'the head is served from the engine clone, never the run dir');
    assert.ok(!commands.some((c) => c.includes('static-server.mjs') && c.includes(join(root, 'repo'))));

    assert.equal(judged.length, 1);
    assert.equal(judged[0].before.length, 2);
    assert.equal(judged[0].after.length, 2);
    assert.equal(judged[0].after[0], PNG.toString('base64'));
    const design = insp.design!;
    assert.equal(design.diffOnly, false);
    assert.equal(design.after, 7);
    assert.equal(design.before, 6);
    assert.deepEqual(design.shots.map((s) => s.route), ['/', '/about']);
    assert.ok(design.shots.every((s) => s.before && s.after && existsSync(s.before) && existsSync(s.after)));
    assert.equal(insp.checks.find((c) => c.name === 'design')?.status, 'pass');
    assert.equal(insp.passed, true);
  } finally {
    lease.release();
  }
});

test('a repo with a screenshot script uses it', { timeout: 60_000 }, async () => {
  const repo = makeRepo(checks({ screenshot: 'npm run shot', preview: null, shots: ['/'] }), {
    'index.html': '<h1>Widgets</h1>\n',
    'app.tsx': 'export const App = () => null;\n',
  });
  const { worker } = team();
  const job = postJob(['**']);
  const { run, diff } = await makeRun(repo, job, worker, (dir) => write(dir, 'app.tsx', 'export const App = () => 1;\n'));
  const lease = await workLease();
  try {
    const insp = await inspect(run, job, repo, diff, lease, { screenshotter });
    assert.equal(shots.length, 0, 'the preview is not used when the repo has its own script');
    const scripted = commands.filter((c) => c.includes('npm run shot'));
    assert.equal(scripted.length, 2, 'once for each side');
    assert.ok(scripted.every((c) => /PALIMPSEST_SHOT='[^']+\.png'/.test(c)));
    const design = insp.design!;
    assert.equal(design.diffOnly, false);
    assert.ok(design.shots[0].before && design.shots[0].after);
    assert.ok(design.shots[0].after!.startsWith(join(paths().runs, run.id, 'inspection')));
    assert.deepEqual(readFileSync(design.shots[0].after!), PNG);
    assert.equal(judged[0].after.length, 1);
  } finally {
    lease.release();
  }
});

test('a Swift UI diff with no preview is judged diffOnly', { timeout: 60_000 }, async () => {
  const repo = makeRepo(checks(), { 'App/ContentView.swift': 'struct ContentView {}\n' });
  const { worker } = team();
  const job = postJob(['**']);
  const { run, diff } = await makeRun(repo, job, worker, (dir) => write(dir, 'App/ContentView.swift', 'struct ContentView { let title = "Widgets" }\n'));
  assert.ok(UI_FILES.test('App/ContentView.swift'));
  const lease = await workLease();
  try {
    const insp = await inspect(run, job, repo, diff, lease, { screenshotter });
    assert.equal(shots.length, 0);
    assert.equal(judged.length, 1);
    assert.deepEqual([judged[0].before, judged[0].after], [[], []]);
    assert.match(judged[0].diff ?? '', /ContentView/);
    assert.equal(insp.design?.diffOnly, true);
    assert.equal(insp.design?.before, null);
    assert.match(insp.checks.find((c) => c.name === 'design')!.detail, /diff text alone/i);
  } finally {
    lease.release();
  }
});

test("a judge call takes a sub-lease of the run's slot and is charged to the city", { timeout: 60_000 }, async () => {
  const run = await workLease();
  const subs: string[] = [];
  const spy: Lease = { signal: run.signal, release: () => run.release(), sub: (kind, model, est) => (subs.push(`${kind} ${model}`), run.sub(kind, model, est)) };
  const dir = mkdtempSync(join(tmpdir(), 'palimpsest-design-shots-'));
  const after = join(dir, 'after.png');
  writeFileSync(after, PNG);
  const ctx = { runId: 'run-judge', runRoot: join(paths().runs, 'run-judge'), dir, log: () => {}, signal: run.signal };
  try {
    const out = await judgeDesign(ctx, [], [{ route: '/', path: after }], 'diff --git a/x.css b/x.css\n', spy);
    assert.equal(subs.length, 1);
    assert.match(subs[0], /^judge /);
    assert.equal(out.after, 7);
    assert.equal(out.diffOnly, false);
    const rows = openDb().prepare("SELECT firm_id, run_id, amount FROM credits WHERE kind = 'judge'").all() as Array<{ firm_id: string | null; run_id: string; amount: number }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].firm_id, null, 'charged to the city, no firm');
    assert.equal(rows[0].run_id, 'run-judge');
    assert.equal(liveLeaseCount(), 1, 'the sub-lease was released; only the run lease is held');

    // A run that is stopped stops its judge: the sub-lease carries the run's abort.
    let seen: AbortSignal | null = null;
    setProvider('ollama', fakeProvider({ judge: (_i, signal) => new Promise((_r, reject) => {
      seen = signal;
      signal.addEventListener('abort', () => reject(new Error('judge aborted')), { once: true });
    }) }));
    const p = judgeDesign(ctx, [], [{ route: '/', path: after }], 'diff', spy);
    while (!seen) await new Promise((r) => setTimeout(r, 5));
    abortLease(run, new Error('stop'));
    await assert.rejects(p);
    assert.equal((seen as AbortSignal).aborted, true);
  } finally {
    run.release();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the screenshotter's request filter aborts the engine port, 11434 and an internet URL and allows the served port", async () => {
  assert.equal(allowShotRequest(`http://127.0.0.1:${SERVED_PORT}/`, SERVED_PORT), true);
  assert.equal(allowShotRequest(`http://127.0.0.1:${SERVED_PORT}/assets/app.js?x=1`, SERVED_PORT), true);
  for (const url of [
    'http://127.0.0.1:4770/api/state',
    'http://127.0.0.1:11434/api/tags',
    'https://example.com/font.woff2',
    `http://localhost:${SERVED_PORT}/`,
    `https://127.0.0.1:${SERVED_PORT}/`,
    `ws://127.0.0.1:${SERVED_PORT}/`,
    `http://127.0.0.1:${SERVED_PORT}@evil.example/`,
    `http://127.0.0.1:${SERVED_PORT + 1}/`,
    'http://[::1]:4770/',
    'file:///etc/hosts',
    'not a url',
  ]) {
    assert.equal(allowShotRequest(url, SERVED_PORT), false, url);
  }

  // Without Playwright: the route handler is installed on the context before any page navigates,
  // aborts what the filter refuses, continues what it allows, and logs each blocked URL.
  const calls: string[] = [];
  let handler: ((route: { request(): { url(): string }; abort(e?: string): Promise<void>; continue(): Promise<void> }) => unknown) | null = null;
  let contextOptions: Record<string, unknown> = {};
  const browser: BrowserLike = {
    async newContext(o) {
      contextOptions = o;
      calls.push('newContext');
      return {
        async route(_url, h) {
          calls.push('route');
          handler = h;
        },
        async routeWebSocket() {
          calls.push('routeWebSocket');
        },
        async newPage() {
          calls.push('newPage');
          return {
            async goto(url: string) {
              calls.push(`goto ${url}`);
            },
            async screenshot(o: { path: string }) {
              calls.push('screenshot');
              writeFileSync(o.path, PNG);
            },
            async close() {},
          };
        },
        async close() {
          calls.push('context.close');
        },
      };
    },
    async close() {
      calls.push('browser.close');
    },
  };
  const blocked: string[] = [];
  const outDir = mkdtempSync(join(tmpdir(), 'palimpsest-design-filter-'));
  try {
    const shoot = playwrightScreenshotter(async () => browser, { settleMs: 0 });
    const log = (l: RunLogLine) => {
      if (l.kind === 'refused') blocked.push(l.text);
    };
    const got = await shoot({ port: SERVED_PORT, routes: ['/', '//evil.example/x'], outDir, side: 'after', log, signal: new AbortController().signal });
    assert.ok(calls.indexOf('route') < calls.findIndex((c) => c.startsWith('goto')), 'the filter is in place before navigation');
    assert.ok(calls.indexOf('routeWebSocket') < calls.findIndex((c) => c.startsWith('goto')));
    assert.deepEqual(calls.filter((c) => c.startsWith('goto')), [`goto http://127.0.0.1:${SERVED_PORT}/`], 'a route that leaves the origin is never visited');
    assert.equal(got.length, 1);
    assert.equal(contextOptions.serviceWorkers, 'block');
    assert.deepEqual(contextOptions.viewport, { width: 1440, height: 900 });
    assert.equal(contextOptions.deviceScaleFactor, 2);
    assert.ok(calls.includes('browser.close'));

    const outcome: string[] = [];
    const fake = (url: string) => ({
      request: () => ({ url: () => url }),
      abort: async () => void outcome.push(`abort ${url}`),
      continue: async () => void outcome.push(`continue ${url}`),
    });
    for (const url of ['http://127.0.0.1:4770/', 'http://127.0.0.1:11434/', 'https://example.com/', `http://127.0.0.1:${SERVED_PORT}/x.css`]) await handler!(fake(url));
    assert.deepEqual(outcome, [
      'abort http://127.0.0.1:4770/',
      'abort http://127.0.0.1:11434/',
      'abort https://example.com/',
      `continue http://127.0.0.1:${SERVED_PORT}/x.css`,
    ]);
    assert.equal(blocked.filter((b) => /4770|11434|example\.com/.test(b)).length, 3);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  return typeof a === 'object' && a ? a.port : 0;
}

test('the real Chromium shoots a served page and reaches no other loopback service', { timeout: 120_000 }, async (t) => {
  try {
    const pw = await import('playwright');
    const b = await pw.chromium.launch({ headless: true });
    await b.close();
  } catch {
    t.skip('Chromium is not available here');
    return;
  }
  // Another loopback service the page tries to reach: it must see nothing.
  let otherHits = 0;
  const other = createServer((_req, res) => {
    otherHits++;
    res.end('no');
  });
  other.on('upgrade', () => otherHits++);
  const otherPort = await listen(other);
  const page = `<!doctype html><html><body style="margin:0;background:#f4f1ea"><h1 style="font:600 40px Georgia;margin:40px">Widgets</h1>
<img src="http://127.0.0.1:${otherPort}/pixel.png">
<script>
fetch('http://127.0.0.1:${otherPort}/fetch').catch(() => {});
fetch('https://example.invalid/').catch(() => {});
try { new WebSocket('ws://127.0.0.1:${otherPort}/ws'); } catch (e) {}
</script></body></html>`;
  const served = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(page);
  });
  const port = await listen(served);
  const outDir = mkdtempSync(join(tmpdir(), 'palimpsest-design-real-'));
  const blocked: string[] = [];
  try {
    const shoot = playwrightScreenshotter(undefined, { settleMs: 300 });
    const got = await shoot({ port, routes: ['/'], outDir, side: 'after', log: (l) => l.kind === 'refused' && blocked.push(l.text), signal: new AbortController().signal });
    assert.equal(got.length, 1);
    const png = readFileSync(got[0].path);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    // 1440 x 900 at device scale 2.
    assert.equal(png.readUInt32BE(16), 2880);
    assert.equal(png.readUInt32BE(20), 1800);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(otherHits, 0, 'no request reached the other loopback service');
    assert.ok(blocked.some((b) => b.includes(String(otherPort))), 'the blocked requests are logged');
  } finally {
    served.close();
    other.close();
    rmSync(outDir, { recursive: true, force: true });
  }
});

test('the static server serves its root only', { timeout: 30_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { symlinkSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'palimpsest-static-'));
  const site = join(dir, 'site');
  mkdirSync(join(site, 'about'), { recursive: true });
  writeFileSync(join(site, 'index.html'), '<h1>home</h1>');
  writeFileSync(join(site, 'about', 'index.html'), '<h1>about</h1>');
  writeFileSync(join(dir, 'secret.txt'), 'secret');
  symlinkSync(join(dir, 'secret.txt'), join(site, 'leak.txt'));
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'engine', 'guild', 'static-server.mjs'), site, '20000'], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.stdout.on('data', (b: Buffer) => {
        const m = /PALIMPSEST_SERVING (\d+)/.exec(b.toString());
        if (m) resolve(Number(m[1]));
      });
      child.on('exit', () => reject(new Error('the server exited')));
    });
    const get = async (path: string) => {
      const { request } = await import('node:http');
      return new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
    };
    assert.equal((await get('/')).body, '<h1>home</h1>');
    assert.equal((await get('/about')).body, '<h1>about</h1>');
    assert.equal((await get('/settings')).body, '<h1>home</h1>', 'an app route falls back to the root page');
    assert.equal((await get('/leak.txt')).status, 404, 'a symlink out of the root is never followed');
    assert.equal((await get('/../secret.txt')).status, 404);
    assert.equal((await get('/%2e%2e/secret.txt')).status, 404);
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a static preview is served under the tool profile and shot by the real Chromium', { timeout: 180_000 }, async (t) => {
  try {
    const pw = await import('playwright');
    const b = await pw.chromium.launch({ headless: true });
    await b.close();
  } catch {
    t.skip('Chromium is not available here');
    return;
  }
  const { realSpawner } = await import('../engine/exec.js');
  const { SANDBOX_EXEC } = await import('../engine/market/sandbox.js');
  // The real spawner, and the real tool profile wherever sandbox-exec exists.
  setSpawner(realSpawner);
  if (existsSync(SANDBOX_EXEC)) delete process.env.PALIMPSEST_SANDBOX;
  const repo = makeRepo(checks({ preview: { kind: 'static', outDir: '.' }, shots: ['/'] }), {
    'index.html': '<!doctype html><link rel="stylesheet" href="style.css"><h1>Widgets</h1>\n',
    'style.css': 'h1 { color: black; font: 600 48px Georgia; }\n',
  });
  const { worker } = team();
  const job = postJob(['**']);
  const { run, diff } = await makeRun(repo, job, worker, (dir) => write(dir, 'style.css', 'h1 { color: navy; font: 600 48px Georgia; }\n'));
  const lease = await workLease();
  try {
    const insp = await inspect(run, job, repo, diff, lease);
    const design = insp.design!;
    assert.equal(design.diffOnly, false);
    assert.equal(design.shots.length, 1);
    for (const path of [design.shots[0].before!, design.shots[0].after!]) {
      const png = readFileSync(path);
      assert.equal(png.readUInt32BE(16), 2880);
      assert.equal(png.readUInt32BE(20), 1800);
    }
    assert.notDeepEqual(readFileSync(design.shots[0].before!), readFileSync(design.shots[0].after!), 'the change shows');
    assert.equal(judged[0].before.length, 1);
    assert.equal(judged[0].after.length, 1);
    // The server ran under the generated tool profile wherever sandbox-exec exists.
    if (existsSync(SANDBOX_EXEC)) assert.ok(existsSync(join(paths().runs, run.id, 'ctl', 'tool.sb')));
  } finally {
    lease.release();
  }
});

// ---------------------------------------------------------------- fix round 1: anti-gaming

test("a preview is always shot by the engine's Chromium, never the repo's script", { timeout: 60_000 }, async () => {
  const repo = makeRepo(checks({ screenshot: 'npm run shot', preview: { kind: 'static', outDir: '.' }, shots: ['/'] }), {
    'index.html': '<h1>Widgets</h1>\n',
    'app.tsx': 'export const App = () => null;\n',
  });
  const { worker } = team();
  const job = postJob(['**']);
  const { run, diff } = await makeRun(repo, job, worker, (dir) => write(dir, 'app.tsx', 'export const App = () => 1;\n'));
  const lease = await workLease();
  try {
    const insp = await inspect(run, job, repo, diff, lease, { screenshotter });
    assert.equal(commands.filter((c) => c.includes('npm run shot')).length, 0, 'the script never runs');
    assert.deepEqual(shots.map((x) => x.side), ['after', 'before']);
    assert.equal(insp.checks.find((c) => c.name === 'design')?.status, 'pass');
  } finally {
    lease.release();
  }
});

test('a screenshot script the diff touches fails design', { timeout: 60_000 }, async () => {
  // The script itself.
  const repo = makeRepo(checks({ screenshot: 'node tools/shot.mjs', shots: ['/'] }), {
    'tools/shot.mjs': 'export {};\n',
    'app.tsx': 'export const App = () => null;\n',
  });
  const { worker } = team();
  const job = postJob(['**']);
  const { run, diff } = await makeRun(repo, job, worker, (dir) => {
    write(dir, 'app.tsx', 'export const App = () => 1;\n');
    write(dir, 'tools/shot.mjs', 'export {}; // writes a pretty picture\n');
  });
  const lease = await workLease();
  try {
    const insp = await inspect(run, job, repo, diff, lease, { screenshotter });
    const d = insp.checks.find((c) => c.name === 'design')!;
    assert.equal(d.status, 'fail');
    assert.match(d.detail, /screenshot script/);
    assert.equal(judged.length, 0);
    assert.equal(commands.filter((c) => c.includes('tools/shot.mjs')).length, 0, 'a touched script is never run');
  } finally {
    lease.release();
  }
});

test('a package script behind the screenshot command that the diff changes fails design', { timeout: 60_000 }, async () => {
  const pkg = (shot: string) => JSON.stringify({ scripts: { shot, test: 'node --test' } }, null, 2) + '\n';
  const repo = makeRepo(checks({ screenshot: 'npm run shot', shots: ['/'] }), {
    'package.json': pkg('node tools/shot.mjs'),
    'app.tsx': 'export const App = () => null;\n',
  }, 'acme/gadgets');
  const { worker } = team();
  const job = postJob(['**'], 'acme/gadgets');
  const { run, diff } = await makeRun(repo, job, worker, (dir) => {
    write(dir, 'app.tsx', 'export const App = () => 1;\n');
    write(dir, 'package.json', pkg('cp pretty.png "$PALIMPSEST_SHOT"'));
  });
  const lease = await workLease();
  try {
    const insp = await inspect(run, job, repo, diff, lease, { screenshotter });
    const d = insp.checks.find((c) => c.name === 'design')!;
    assert.equal(d.status, 'fail');
    assert.match(d.detail, /screenshot script/);
  } finally {
    lease.release();
  }
});

test('ignored build output in the run dir is never served, and head code cannot reach the before shot', { timeout: 120_000 }, async () => {
  const { realSpawner } = await import('../engine/exec.js');
  setSpawner(realSpawner);
  // The test writes poison into the run's HOME and cache; the build bakes it into the page when it finds it.
  const build = 'mkdir -p dist && if [ -e "$HOME/poison" ] || [ -e "$XDG_CACHE_HOME/poison" ]; then echo POISONED > dist/index.html; else cp index.html dist/index.html; fi';
  const repo = makeRepo(checks({ test: 'touch "$HOME/poison" "$XDG_CACHE_HOME/poison"', build, preview: { kind: 'static', outDir: 'dist' }, shots: ['/'] }), {
    '.gitignore': 'dist/\n',
    'index.html': '<h1>Widgets</h1>\n',
    'style.css': 'h1 { color: black; }\n',
  });
  const { worker } = team();
  const job = postJob(['**']);
  const { run, diff } = await makeRun(repo, job, worker, (dir) => {
    write(dir, 'style.css', 'h1 { color: navy; }\n');
    write(dir, 'dist/index.html', 'TAMPERED\n');
  });
  const bodies: Record<string, string> = {};
  const fetching: Screenshotter = async (o) => {
    const res = await fetch(`http://127.0.0.1:${o.port}/`);
    bodies[o.side] = await res.text();
    return screenshotter(o);
  };
  const lease = await workLease();
  try {
    await inspect(run, job, repo, diff, lease, { screenshotter: fetching });
    assert.doesNotMatch(bodies.after ?? '', /TAMPERED/, 'the head is built and served from the engine clone');
    assert.match(bodies.after ?? '', /POISONED/, 'the head checks did write their poison');
    assert.match(bodies.before ?? '', /Widgets/, 'the base side never sees what the head left in HOME or the cache');
  } finally {
    lease.release();
  }
});
