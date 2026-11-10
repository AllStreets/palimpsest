/**
 * The design check (Task 15, rulings 13 and 24): before and after
 * screenshots of every UI change the guild can render, and the vision
 * judge that scores them against his design bar (`design-bar.md`).
 *
 * Rendering: a detected preview is always shot by the engine's own
 * Chromium (the repo's script is ignored then); only a repo with no
 * preview uses its own `checks.screenshot` script, run through execTool()
 * with `PALIMPSEST_SHOT=<path>` (and the route in `PALIMPSEST_ROUTE`), and
 * never when the change touches that script (inspect.ts). The preview is built with
 * `checks.build` through execTool(), served from its output directory by
 * `static-server.mjs`, itself started through execTool() under the tool
 * profile on a loopback port the kernel picks, and shot from outside the
 * sandbox by the engine's Playwright (headless Chromium, 1440 x 900 at
 * device scale 2). The browser context routes every request through
 * `allowShotRequest()`: anything whose origin is not exactly
 * `http://127.0.0.1:<that port>` is aborted and logged (the engine port,
 * Ollama's 11434, the internet, any other loopback service); WebSockets
 * are closed and service workers blocked. The base side is a checkout of
 * the base sha the engine makes in `<runRoot>/base`. Shots are kept under
 * `<runRoot>/inspection/shots`.
 *
 * Only when a repo has no script and no preview at all is the change
 * judged from its diff text alone (`diffOnly`), and the report says so.
 * The judge's call is a `judge` sub-lease of the run's work lease
 * (ruling 28) and is charged to the city, never to a firm.
 */
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ModelRef, Repo } from '../../shared/types.js';
import { chargesItself } from '../market/anthropic-api.js';
import { enginePort, execTool } from '../market/broker.js';
import { charge, JUDGE_ESTIMATE, type Lease } from '../market/budget.js';
import type { Egress } from '../market/egress.js';
import { installDeps as defaultInstallDeps, type InstallDeps, type RunContext } from '../market/install.js';
import type { RunLogLine, Usage } from '../market/provider.js';
import { providerFor } from '../market/providers.js';
import { BASE_SCRATCH } from '../market/sandbox.js';
import { createBaseDir, engineGit, removeOwned } from '../market/worktree.js';
import { CHECK_MS } from './checks.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** A diff touching any of these is a UI change and gets the design check. */
export const UI_FILES = /\.(css|scss|html|tsx|jsx|vue|svelte|swift|astro)$/;
/** The viewport every shot is taken at, and its device scale. */
export const VIEWPORT = { width: 1440, height: 900 } as const;
export const DEVICE_SCALE = 2;
/** The lowest after score that passes. */
export const DESIGN_PASS = 6;
/** The vision judge (Task 10's Ollama path); it sees the screenshots. */
export const VISION_JUDGE: ModelRef = 'ollama:qwen2.5vl:7b*';
/** A text judge for the diff-only case when no vision model can take the call. */
export const TEXT_JUDGE: ModelRef = 'claude:sonnet';

/** How long the static server may live, and how long the engine waits for it to say its port. */
const SERVE_MS = 10 * 60_000;
const SERVE_WAIT_MS = 30_000;
/** One run of the repo's own screenshot script. */
const SHOT_SCRIPT_MS = 5 * 60_000;
/** One page load. */
const NAV_MS = 30_000;
/** The largest screenshot kept. */
const MAX_SHOT_BYTES = 20 * 1024 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface Shot {
  route: string;
  path: string;
}

/** His design bar, in prose, for the judge. */
export function designBar(): string {
  return readFileSync(join(HERE, 'design-bar.md'), 'utf8');
}

/** True when `before` and `after` pass: after at least DESIGN_PASS and no more than one point below before. */
export function designPasses(before: number | null, after: number): boolean {
  return after >= DESIGN_PASS && (before === null || after >= before - 1);
}

// ---------------------------------------------------------------- the request filter

/**
 * True only for a request whose origin is exactly `http://127.0.0.1:<port>`
 * (no credentials in the URL), plus `data:` and `blob:` URLs, which never
 * leave the page. Everything else a shot's page asks for is aborted.
 */
export function allowShotRequest(url: string, port: number): boolean {
  if (url.startsWith('data:') || url.startsWith('blob:')) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port === String(port) && !u.username && !u.password;
}

// ---------------------------------------------------------------- the screenshotter

export interface ShotTarget {
  port: number;
  routes: string[];
  outDir: string;
  side: 'before' | 'after';
  log: (line: RunLogLine) => void;
  signal: AbortSignal;
}

export type Screenshotter = (o: ShotTarget) => Promise<Shot[]>;

/** The parts of Playwright the screenshotter uses, so a test can stand in for the browser. */
export interface RouteLike {
  request(): { url(): string };
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}
export interface PageLike {
  goto(url: string, o?: Record<string, unknown>): Promise<unknown>;
  screenshot(o: { path: string; fullPage?: boolean }): Promise<unknown>;
  close(): Promise<void>;
}
export interface ContextLike {
  route(url: string, handler: (route: RouteLike) => unknown): Promise<void>;
  routeWebSocket?(url: RegExp, handler: (ws: { close(): unknown; url(): string }) => unknown): Promise<void>;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
export interface BrowserLike {
  newContext(o: Record<string, unknown>): Promise<ContextLike>;
  close(): Promise<void>;
}

/** Chromium flags that keep the browser off the network beyond the served port. */
const CHROMIUM_ARGS = [
  // Every hostname fails to resolve: no DNS, no prefetch, no internet by name.
  '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
  '--dns-prefetch-disable',
  '--no-pings',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
];

/** Launches the engine's headless Chromium with its own sandbox on. */
async function launchChromium(): Promise<BrowserLike> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true, chromiumSandbox: true, args: CHROMIUM_ARGS });
  return browser as unknown as BrowserLike;
}

const nowIso = () => new Date().toISOString();

/**
 * The real screenshotter: one browser per side, one context with the
 * request filter installed before any page exists, then each route at
 * 1440 x 900 at device scale 2. A route that would leave the served origin
 * is never visited. The browser closes on every end and on abort.
 */
export function playwrightScreenshotter(launch: () => Promise<BrowserLike> = launchChromium, o: { settleMs?: number } = {}): Screenshotter {
  const settleMs = o.settleMs ?? 500;
  return async (t) => {
    if (t.signal.aborted) throw new Error('The screenshots were stopped.');
    const origin = `http://127.0.0.1:${t.port}`;
    const blocked = (url: string, what = 'request') => {
      t.log({ at: nowIso(), kind: 'refused', text: `design: blocked ${what} to ${url.slice(0, 500)}`, data: { url: url.slice(0, 2000), side: t.side } });
    };
    const browser = await launch();
    const onAbort = () => void browser.close().catch(() => {});
    t.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const context = await browser.newContext({
        viewport: { ...VIEWPORT },
        deviceScaleFactor: DEVICE_SCALE,
        serviceWorkers: 'block',
        acceptDownloads: false,
        permissions: [],
        javaScriptEnabled: true,
      });
      // The filter is in place before the first page exists, so nothing loads unfiltered.
      await context.route('**/*', async (route) => {
        const url = route.request().url();
        if (allowShotRequest(url, t.port)) {
          await route.continue();
          return;
        }
        blocked(url);
        await route.abort('blockedbyclient');
      });
      if (context.routeWebSocket) {
        await context.routeWebSocket(/.*/, (ws) => {
          blocked(ws.url(), 'websocket');
          ws.close();
        });
      }
      mkdirSync(t.outDir, { recursive: true });
      const out: Shot[] = [];
      for (const [i, route] of t.routes.entries()) {
        if (t.signal.aborted) throw new Error('The screenshots were stopped.');
        let url: string;
        try {
          url = new URL(route, `${origin}/`).href;
        } catch {
          url = '';
        }
        if (!url || !allowShotRequest(url, t.port)) {
          blocked(route, 'route');
          continue;
        }
        const page = await context.newPage();
        try {
          await page.goto(url, { waitUntil: 'load', timeout: NAV_MS });
          if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
          const path = join(t.outDir, `${t.side}-${i}.png`);
          await page.screenshot({ path, fullPage: false });
          out.push({ route, path });
        } catch (err) {
          if (t.signal.aborted) throw err;
          t.log({ at: nowIso(), kind: 'engine', text: `design: ${route} could not be shot: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` });
        } finally {
          await page.close().catch(() => {});
        }
      }
      await context.close().catch(() => {});
      return out;
    } finally {
      t.signal.removeEventListener('abort', onAbort);
      await browser.close().catch(() => {});
    }
  };
}

// ---------------------------------------------------------------- serving and shooting

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Copies static-server.mjs into `<runRoot>/ctl/bin` (read-only), where the tool profile can read it. */
function installStaticServer(runRoot: string): string {
  const bin = join(runRoot, 'ctl', 'bin');
  mkdirSync(bin, { recursive: true });
  const src = readFileSync(join(HERE, 'static-server.mjs'), 'utf8');
  const dest = join(bin, 'static-server.mjs');
  let same = false;
  try {
    same = readFileSync(dest, 'utf8') === src;
  } catch {
    same = false;
  }
  if (!same) {
    try {
      unlinkSync(dest);
    } catch {
      // not there yet
    }
    writeFileSync(dest, src, { mode: 0o444 });
    chmodSync(dest, 0o444);
  }
  return dest;
}

function stopped(signal: AbortSignal): Promise<never> {
  return new Promise((_r, reject) => {
    const fail = () => reject(new Error('The design check was stopped.'));
    if (signal.aborted) fail();
    else signal.addEventListener('abort', fail, { once: true });
  });
}

/**
 * Serves `root` (inside the clone `ctx.dir`) from the static server under
 * the tool profile and resolves with its port once it says so. `stop()`
 * ends it and waits for the command to finish (and its group to be reaped).
 */
async function serve(ctx: RunContext, root: string): Promise<{ port: number; stop: () => Promise<void> }> {
  const script = installStaticServer(ctx.runRoot);
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (ctx.signal.aborted) ac.abort();
  else ctx.signal.addEventListener('abort', onAbort, { once: true });
  let said!: (port: number) => void;
  const port = new Promise<number>((r) => (said = r));
  const log = (line: RunLogLine) => {
    ctx.log(line);
    const stream = (line.data as { stream?: unknown } | undefined)?.stream;
    if (line.kind === 'tool' && stream === 'stdout') {
      const m = /^PALIMPSEST_SERVING (\d{1,5})$/.exec(line.text.trim());
      if (m) said(Number(m[1]));
    }
  };
  const command = `${q(process.execPath)} ${q(script)} ${q(root)} ${SERVE_MS}`;
  const done = execTool({ runId: ctx.runId, runRoot: ctx.runRoot, dir: ctx.dir, log, signal: ac.signal, command, timeoutMs: SERVE_MS, stage: 'checks' });
  const stop = async () => {
    ac.abort();
    ctx.signal.removeEventListener('abort', onAbort);
    await done.catch(() => {});
  };
  let timer: NodeJS.Timeout | undefined;
  try {
    const p = await Promise.race([
      port,
      done.then((r) => {
        throw new Error(r.refused ? `The static server was refused: ${r.refused}` : `The static server stopped before it served (exit ${r.code ?? 'none'}).`);
      }),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => reject(new Error('The static server never said its port.')), SERVE_WAIT_MS);
      }),
      stopped(ctx.signal),
    ]);
    if (!Number.isInteger(p) || p < 1 || p > 65535 || p === enginePort() || p === 11434) throw new Error(`The static server named an unusable port ${p}.`);
    return { port: p, stop };
  } catch (err) {
    await stop();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** A screenshot the repo's script wrote: a regular file (no symlink), not too large, a PNG; null otherwise. */
function readShot(path: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_SHOT_BYTES || st.size < PNG_MAGIC.length) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    const bytes = buf.subarray(0, off);
    return bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC) ? bytes : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export interface ShootOptions {
  side: 'before' | 'after';
  /** The browser side (default the real Playwright screenshotter). */
  screenshotter?: Screenshotter;
  /** The clone's build already ran and passed in this inspection, so its output is there. */
  built?: boolean;
}

/**
 * Shoots `routes` of the clone `ctx.dir`, which must be checked out at
 * `sha`: through the repo's screenshot script, else its preview, else
 * nothing (`[]`). Shots land in `<runRoot>/inspection/shots`. Rejects when
 * the run's signal aborts, the clone is not at `sha`, or the preview
 * cannot be built or served.
 */
export async function shoot(ctx: RunContext, repo: Repo, sha: string, routes: string[], opts: ShootOptions): Promise<Shot[]> {
  const c = repo.checks;
  if (!c || (!c.screenshot && !c.preview)) return [];
  if (ctx.signal.aborted) throw new Error('The design check was stopped.');
  const head = (await engineGit(ctx.dir, ['rev-parse', 'HEAD'])).stdout.trim();
  if (head !== sha) throw new Error(`The ${opts.side} side is at ${head.slice(0, 7)}, not ${sha.slice(0, 7)}.`);
  const outDir = join(ctx.runRoot, 'inspection', 'shots');
  mkdirSync(outDir, { recursive: true });
  const log = (text: string) => ctx.log({ at: nowIso(), kind: 'engine', text: `design: ${text}` });

  // A preview is always shot by the engine's own Chromium; the repo's script is used only without one.
  if (c.screenshot && !c.preview) {
    const out: Shot[] = [];
    for (const [i, route] of routes.entries()) {
      // Each side writes only its own tmp (the base side cannot write the head's, nor the head the base's).
      const tmp = join(ctx.runRoot, basename(ctx.dir) === 'base' ? BASE_SCRATCH.tmp : 'tmp', 'shots', `${opts.side}-${i}.png`);
      mkdirSync(dirname(tmp), { recursive: true });
      rmSync(tmp, { force: true });
      const command = `PALIMPSEST_SHOT=${q(tmp)} PALIMPSEST_ROUTE=${q(route)} ${c.screenshot}`;
      const r = await execTool({ runId: ctx.runId, runRoot: ctx.runRoot, dir: ctx.dir, log: ctx.log, signal: ctx.signal, command, timeoutMs: SHOT_SCRIPT_MS, stage: 'checks' });
      if (ctx.signal.aborted) throw new Error('The design check was stopped.');
      if (r.refused || r.code !== 0) {
        log(`the screenshot script failed for ${route} on the ${opts.side} side`);
        continue;
      }
      const png = readShot(tmp);
      if (!png) {
        log(`the screenshot script wrote no PNG for ${route} on the ${opts.side} side`);
        continue;
      }
      const path = join(outDir, `${opts.side}-${i}.png`);
      writeFileSync(path, png);
      out.push({ route, path });
    }
    return out;
  }

  const preview = c.preview!;
  if (c.build && !opts.built) {
    const r = await execTool({ runId: ctx.runId, runRoot: ctx.runRoot, dir: ctx.dir, log: ctx.log, signal: ctx.signal, command: c.build, timeoutMs: CHECK_MS, stage: 'checks' });
    if (ctx.signal.aborted) throw new Error('The design check was stopped.');
    if (r.refused || r.code !== 0) throw new Error(`The ${opts.side} side did not build.`);
  }
  const root = join(ctx.dir, preview.outDir);
  if (!existsSync(root)) throw new Error(`The ${opts.side} side has no ${preview.outDir} to serve.`);
  const server = await serve(ctx, root);
  try {
    const shooter = opts.screenshotter ?? playwrightScreenshotter();
    return await shooter({ port: server.port, routes, outDir, side: opts.side, log: ctx.log, signal: ctx.signal });
  } finally {
    await server.stop();
  }
}

/**
 * The base side's clone: `<runRoot>/base` at `baseSha`, made by the engine,
 * with the repo's dependencies installed when it will build or run a
 * script (egress to the registries only, then back to nothing).
 */
export async function prepareBase(
  ctx: RunContext,
  repo: Repo,
  baseSha: string,
  o: { egress?: Pick<Egress, 'setStage'>; installDeps?: InstallDeps } = {},
): Promise<RunContext> {
  // A base clone and scratch dirs left by an earlier inspection of this run are replaced, never reused.
  for (const d of ['base', ...Object.values(BASE_SCRATCH)]) removeOwned(join(ctx.runRoot, d));
  for (const d of Object.values(BASE_SCRATCH)) mkdirSync(join(ctx.runRoot, d), { recursive: true });
  const dir = await createBaseDir(repo, ctx.runId, baseSha);
  const base: RunContext = { ...ctx, dir, egress: o.egress ?? ctx.egress };
  const c = repo.checks;
  const runs = !!c && (!!c.screenshot || (!!c.preview && !!c.build));
  if (runs && c?.install) {
    const install = await (o.installDeps ?? defaultInstallDeps)(base, repo);
    base.egress?.setStage('checks', []);
    if (install.status === 'fail') throw new Error(`The base side's install failed: ${install.detail}`);
  }
  return base;
}

// ---------------------------------------------------------------- the judge

export interface JudgeOutcome {
  before: number | null;
  after: number;
  diffOnly: boolean;
  notes: string;
  usage: Usage;
  /** Credits the city was charged for the judge's calls. */
  credits: number;
}

const ZERO: Usage = { weightedTokens: 0, seconds: 0, usd: 0, credits: 0 };

function cleanUsage(u: unknown): Usage {
  const o = (u && typeof u === 'object' ? u : {}) as Record<string, unknown>;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
  return { weightedTokens: n(o.weightedTokens), seconds: n(o.seconds), usd: n(o.usd), credits: n(o.credits) };
}

/**
 * Scores the change against the design bar with a `judge` sub-lease of the
 * run's work lease (ruling 28), charged to the city. With no shot on either
 * side the judge sees the diff text alone (`diffOnly`, ruling 13). The
 * vision judge goes first; a text judge is tried only for the diff-only
 * case. Rejects when the run's lease aborts or no judge can take the call.
 */
export async function judgeDesign(
  ctx: Pick<RunContext, 'runId' | 'log'>,
  before: Shot[],
  after: Shot[],
  diff: string,
  lease: Lease,
  o: { models?: ModelRef[]; unattended?: boolean } = {},
): Promise<JudgeOutcome> {
  const diffOnly = before.length === 0 && after.length === 0;
  const images = (list: Shot[]) =>
    list.flatMap((s) => {
      const png = readShot(s.path);
      return png ? [png.toString('base64')] : [];
    });
  const input = { bar: designBar(), before: images(before), after: images(after), diff };
  const models = o.models ?? (diffOnly ? [VISION_JUDGE, TEXT_JUDGE] : [VISION_JUDGE]);
  const problems: string[] = [];
  let credits = 0;
  for (const model of models) {
    if (lease.signal.aborted) throw new Error('The design check was stopped.');
    const sub = lease.sub('judge', model, JUDGE_ESTIMATE);
    if (!('signal' in sub)) {
      problems.push(`${model}: ${sub.reason.detail}`);
      continue;
    }
    const provider = providerFor(model);
    const bill = (usage: Usage, floor: number) => {
      if (provider.kind === 'anthropic' && chargesItself) return;
      try {
        credits += charge({ runId: ctx.runId, firmId: null, model, kind: 'judge', usage, unattended: !!o.unattended, lease: sub, minCredits: floor });
      } catch (err) {
        ctx.log({ at: nowIso(), kind: 'engine', text: `design: the judge call could not be charged: ${err instanceof Error ? err.message : String(err)}` });
      }
    };
    try {
      const out = await provider.judge(input, sub.signal);
      const usage = cleanUsage(out.usage);
      bill(usage, 0);
      const clamp = (x: number) => Math.max(0, Math.min(10, x));
      return {
        before: input.before.length && typeof out.before === 'number' && Number.isFinite(out.before) ? clamp(out.before) : null,
        after: Number.isFinite(out.after) ? clamp(out.after) : 0,
        diffOnly,
        notes: String(out.notes ?? '').slice(0, 4000),
        usage,
        credits,
      };
    } catch (err) {
      // A call that failed or was stopped still cost something on his plan: at least the estimate.
      bill(ZERO, model.startsWith('claude:') ? JUDGE_ESTIMATE : 0);
      if (sub.signal.aborted || lease.signal.aborted) throw err;
      problems.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      sub.release();
    }
  }
  throw new Error(`No design judge could score the change (${problems.join('; ') || 'none tried'}).`);
}
