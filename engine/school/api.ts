/**
 * The school over HTTP (Phase 4 Task 28): the school whole, a net, a voyage,
 * a graduate and the campus to read; "Train now", the base model's download,
 * an arena build and his autonomy grants to act. The server has already
 * checked Host, Origin and, for every write, the `x-palimpsest` header
 * before a request gets here (the market's handler calls this one).
 *
 * Nothing here serves a place on this Mac: a net's weights path, the
 * trainer's Python, a training or rows file, an arena task's body, a
 * genome's body or an Understudy shot path. Every view passes `schoolScrub`
 * (keys that name files dropped, every string redacted and any absolute or
 * data-home path in it cut to `[path]`) before the market's own `scrub()`.
 *
 * `downloadBase()` is called from here and nowhere else: the base model
 * comes down on his click only (Decision 6, Task 25).
 */
import type { IncomingMessage } from 'node:http';

import { FEATURES } from '../../shared/net-features.js';
import { LORA, voyageQueued, WORK_KINDS } from '../../shared/school-rules.js';
import type { ArenaInfo, Graduate, NetName, NetVersion, SchoolSettings, Settings, TrainState, VoyageView, WorkKind } from '../../shared/types.js';
import { AUDIT_MODEL_SHAPE } from '../../shared/market-rules.js';
import { openDb } from '../db.js';
import { emit } from '../events.js';
import { HttpError, readJsonBody } from '../http.js';
import { record } from '../ledger.js';
import { getRepo, isValidFullName, BAD_NAME } from '../repos.js';
import { getSettings } from '../settings.js';
import { redact } from '../market/jobs.js';
import { buildPast, buildPlanted, listArenas, refusal } from './arenas.js';
import { decline, grant, grants, revoke } from './autonomy.js';
import { campusView } from './campus.js';
import { agreement, agreements } from './decisions.js';
import { gateNow, startTrainNow, stopTrainNow } from './gate.js';
import { verifiedCounts } from './history.js';
import { baseReady, downloadBase, graduates } from './lora.js';
import { netCard, netCards, versions } from './nets.js';
import { registerAbort } from './tick.js';
import { liveTrains } from './trainer.js';
import { trainerStatus, type TrainerStatus } from './trainer-env.js';
import { voyage, voyages } from './voyage-table.js';

/** The market handler's sender: scrubs and writes the answer. */
export type Send = (status: number, body: unknown) => true;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
/** How many trains the school view lists, newest first. */
const TRAINS_SHOWN = 20;
/** How long the trainer's status is kept: asking pings its Python, which is not free. */
const TRAINER_TTL_MS = 60_000;

// ---------------------------------------------------------------- redaction

/** Keys whose values are files or bodies of this Mac's: dropped from every school view, wherever they sit. */
const DROP = new Set(['path', 'python', 'file', 'validPath', 'dir', 'logPath', 'patchPath', 'runRoot', 'markdownPath', 'body', 'input', 'truth', 'messages', 'shot', 'shotPath', 'pid']);
/** An absolute path (or the data home redact() left as `[home]`) inside a sentence, to its end. */
const ABSOLUTE = /(?:\[home\]|(?<![\w.~-])\/(?:private|var|tmp|Users|Volumes|opt|home|Library|System|Applications|usr|etc)(?=\/|\b))[^\s'"`)]*/g;

/** Text as a school view may carry it: tokens and home paths redacted, and any other absolute path cut. */
function schoolText(s: string): string {
  // A Mac's data folders have a space in their name (Understudy's shots, the data home): joined first, so the whole path is cut.
  return redact(s.replace(/\/Library\/(Application|Mobile) (Support|Documents)\//g, '/Library/$1_$2/')).replace(ABSOLUTE, '[path]');
}

/** A value as a school view may carry it: file and body keys dropped, every string cleaned. */
export function schoolScrub(value: unknown): unknown {
  if (typeof value === 'string') return schoolText(value);
  if (Array.isArray(value)) return value.map(schoolScrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (!DROP.has(k)) out[k] = schoolScrub(v);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------- the trainer and the download

let trainerProbe: () => Promise<TrainerStatus> = () => trainerStatus();
let trainerCache: { at: number; value: Promise<TrainerStatus> } | null = null;

/** Replaces how the trainer is asked (tests: `() => trainerStatus(null)`), or `null` for the real ask. */
export function setTrainerProbe(fn: (() => Promise<TrainerStatus>) | null): void {
  trainerProbe = fn ?? (() => trainerStatus());
  trainerCache = null;
}

/** How his click downloads the base model: lora.ts's download, or a stand-in a test installs so nothing comes down. */
let baseDownloader: () => ReturnType<typeof downloadBase> = () => downloadBase();

/** Replaces how the base model is downloaded (the UI test's stand-in), or `null` for lora.ts's real download. */
export function setBaseDownloader(fn: (() => ReturnType<typeof downloadBase>) | null): void {
  baseDownloader = fn ?? (() => downloadBase());
}

/** The base model's download as his last click left it: running, or how it ended. */
let lastDownload: { running: boolean; status: 'ready' | 'failed' | null; reason: string | null } | null = null;

/** Forgets the trainer's kept status and the last download (tests). */
export function resetSchoolApi(): void {
  trainerCache = null;
  lastDownload = null;
}

/** The trainer's status without its Python's path. */
async function trainerView(): Promise<Omit<TrainerStatus, 'python'>> {
  const t = Date.now();
  if (!trainerCache || t - trainerCache.at > TRAINER_TTL_MS || t < trainerCache.at) trainerCache = { at: t, value: trainerProbe() };
  let s: TrainerStatus;
  try {
    s = await trainerCache.value;
  } catch (err) {
    trainerCache = null;
    return { ready: false, reason: `The trainer could not be asked: ${err instanceof Error ? err.message : String(err)}`, arch: null, mlx: null, mlxLm: null, pinned: false };
  }
  const { python: _python, ...rest } = s;
  return rest;
}

/** His click: the base model downloads in the background (Decision 6); the school view says how it went. */
function startDownload(): { status: 'ready' | 'downloading' } {
  if (baseReady()) return { status: 'ready' };
  if (lastDownload?.running) return { status: 'downloading' };
  const entry: NonNullable<typeof lastDownload> = { running: true, status: null, reason: null };
  lastDownload = entry;
  void baseDownloader().then(
    (r) => {
      entry.running = false;
      entry.status = r.status;
      entry.reason = r.reason;
    },
    (err: unknown) => {
      entry.running = false;
      entry.status = 'failed';
      entry.reason = `The base model did not download: ${err instanceof Error ? err.message : String(err)}`;
    },
  );
  return { status: 'downloading' };
}

// ---------------------------------------------------------------- views

/** A voyage as the school screens show it: `queued` when it is a commission not yet sailed, its champion's genome body left out. */
export function voyageOut(v: VoyageView): VoyageView {
  const out: VoyageView = { ...v, queued: voyageQueued(v) };
  if (v.champion) {
    const { body: _body, ...champion } = v.champion;
    out.champion = champion;
  }
  return out;
}

/** The newest trains, the live ones as they stand now (steps and status read from the process, not the row). */
function recentTrains(): TrainState[] {
  const rows = openDb().prepare('SELECT json FROM trains').all() as Array<{ json: string }>;
  const byId = new Map<string, TrainState>();
  for (const r of rows) {
    try {
      const t = JSON.parse(r.json) as TrainState;
      if (t && typeof t.id === 'string') byId.set(t.id, t);
    } catch {
      // a row that cannot be read is left out
    }
  }
  for (const t of liveTrains()) byId.set(t.id, t);
  return [...byId.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id)).slice(0, TRAINS_SHOWN);
}

/** What `GET /api/school` answers. */
export interface SchoolView {
  settings: SchoolSettings;
  gate: { light: Awaited<ReturnType<typeof gateNow>>; heavy: Awaited<ReturnType<typeof gateNow>> };
  trainer: Omit<TrainerStatus, 'python'>;
  nets: ReturnType<typeof netCards>;
  agreements: ReturnType<typeof agreements>;
  grants: ReturnType<typeof grants>;
  /** The master's agreement on each granted or asked pair's own repo (ruling 16): agreement(kind, repo), one per grant. */
  grantAgreements: ReturnType<typeof agreement>[];
  arenas: ArenaInfo[];
  /** Builds he asked for that the engine refused as they started, newest first, with the reason. */
  arenaRefusals: ArenaRefusal[];
  voyages: VoyageView[];
  graduates: Graduate[];
  trains: TrainState[];
  lora: {
    examples: number;
    needs: number;
    counts: ReturnType<typeof verifiedCounts>;
    baseReady: boolean;
    /** His last click on "Download the base model": running, or how it ended (null before any click since the engine started). */
    download: { running: boolean; status: 'ready' | 'failed' | null; reason: string | null } | null;
  };
}

export async function schoolView(now: number = Date.now()): Promise<SchoolView> {
  // The light gate reads every probe; the heavy gate's read follows it from the probes' cache.
  const light = await gateNow('light', now);
  const heavy = await gateNow('heavy', now);
  const counts = verifiedCounts();
  const examples = Object.values(counts).reduce((n, c) => n + c.city + c.pr + c.commit, 0);
  const pairs = grants();
  return {
    settings: getSettings().school,
    gate: { light, heavy },
    trainer: await trainerView(),
    nets: netCards(now),
    agreements: agreements(),
    grants: pairs,
    grantAgreements: pairs.map((g) => agreement(g.kind, g.repo)),
    arenas: listArenas(),
    arenaRefusals: arenaRefusals(),
    voyages: voyages().map(voyageOut),
    graduates: graduates(),
    trains: recentTrains(),
    lora: { examples, needs: LORA.min, counts, baseReady: baseReady(), download: lastDownload ? { ...lastDownload } : null },
  };
}

function netOf(raw: string): NetName {
  if (!Object.hasOwn(FEATURES, raw)) throw new HttpError(404, { error: 'unknown net' });
  return raw as NetName;
}

// The server decodes the path before it gets here: each segment is checked as it stands, never decoded again.

function idOf(s: string, what: string): string {
  if (!ID.test(s)) throw new HttpError(400, { error: `That is not a ${what} id.` });
  return s;
}

function repoOf(owner: string, name: string): string {
  const full = `${owner}/${name}`;
  if (!isValidFullName(full)) throw new HttpError(400, { error: BAD_NAME });
  return full;
}

function kindOf(k: string): WorkKind {
  if (!(WORK_KINDS as readonly string[]).includes(k)) throw new HttpError(400, { error: 'That is not a kind of work autonomy covers.' });
  return k as WorkKind;
}

/** A refused move of his is a conflict with where the pair stands, said in the engine's words. */
function refusing<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(409, { error: err instanceof Error ? err.message : String(err) });
  }
}

// ---------------------------------------------------------------- settings

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SCHOOL_FIELDS = new Set(['enabled', 'window', 'idleMinutes', 'allowLowPower', 'claudeCreditsPerDay', 'designer', 'understudy', 'commitsAsWork']);
const wholeIn = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;

/** A school setting's name as he reads it in Settings, for the engine's refusals. */
const FIELD_WORDS: Record<string, string> = {
  enabled: 'Run the school',
  allowLowPower: 'Train in Low Power mode on power',
  understudy: 'Read your taste from Understudy',
  commitsAsWork: 'Count my own commits as verified work',
};

/**
 * Checks the `school` part of a `PATCH /api/settings` against the current
 * school settings: the merged settings, or the first refusal in words he
 * can act on (Settings shows it in place, as the engine wrote it).
 */
function checkSchool(v: unknown, current: Settings['school']): { next: Settings['school'] } | { refused: string } {
  const no = (refused: string) => ({ refused });
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return no('The school settings are sent as an object.');
  const b = v as Record<string, unknown>;
  const stray = Object.keys(b).find((k) => !SCHOOL_FIELDS.has(k));
  if (stray !== undefined) return no(stray === 'trainNowUntil' || stray === 'baseModel' || stray === 'baseModelReady' ? `${stray} is set by the school itself, not from Settings.` : `${stray} is not a school setting.`);
  const next: SchoolSettings = { ...current, window: { ...current.window } };
  for (const k of ['enabled', 'allowLowPower', 'understudy', 'commitsAsWork'] as const) {
    if (!(k in b)) continue;
    if (typeof b[k] !== 'boolean') return no(`${FIELD_WORDS[k]} is either on or off.`);
    next[k] = b[k] as boolean;
  }
  if ('idleMinutes' in b) {
    if (!wholeIn(b.idleMinutes, 5, 120)) return no('The idle wait is a whole number of minutes, 5 to 120.');
    next.idleMinutes = b.idleMinutes;
  }
  if ('claudeCreditsPerDay' in b) {
    if (!wholeIn(b.claudeCreditsPerDay, 0, 100)) return no('The school may spend a whole number of credits a day, 0 to 100.');
    next.claudeCreditsPerDay = b.claudeCreditsPerDay;
  }
  if ('designer' in b) {
    if (typeof b.designer !== 'string' || !AUDIT_MODEL_SHAPE.test(b.designer)) return no('Name a model as ollama:<name> or claude:<name>.');
    next.designer = b.designer as SchoolSettings['designer'];
  }
  if ('window' in b) {
    const w = b.window as Record<string, unknown> | null;
    if (typeof w !== 'object' || w === null || Array.isArray(w) || Object.keys(w).some((k) => k !== 'from' && k !== 'to')) return no('The window is sent as { from, to }.');
    const from = 'from' in w ? w.from : next.window.from;
    const to = 'to' in w ? w.to : next.window.to;
    for (const t of [from, to]) {
      if (typeof t !== 'string' || !HHMM.test(t)) return no(`${typeof t === 'string' && t.trim() ? `${t.trim().slice(0, 12)} is not a time of day` : 'A time is missing'}: say it as hours and minutes, 00:00 to 23:59.`);
    }
    if (from === to) return no('The window starts and ends at the same time; give it some hours.');
    next.window = { from: from as string, to: to as string };
  }
  return { next };
}

/**
 * The `school` part of a `PATCH /api/settings`, merged onto the current
 * school settings, or null when anything in it is not allowed. The designer
 * is checked by its shape only: no route runs `ollama list`. `trainNowUntil`
 * is set only by "Train now", and `baseModel` and `baseModelReady` only by
 * the download.
 */
export function schoolPatch(v: unknown, current: Settings['school']): Settings['school'] | null {
  const r = checkSchool(v, current);
  return 'next' in r ? r.next : null;
}

/** Why the `school` part of a settings patch is refused, in his words, or null when it is allowed. */
export function schoolRefusal(v: unknown, current: Settings['school']): string | null {
  const r = checkSchool(v, current);
  return 'refused' in r ? r.refused : null;
}

// ---------------------------------------------------------------- routes

/** An arena build he asked for that the engine refused as it started (`arena.refused`), as the school view lists it. */
export interface ArenaRefusal {
  repo: string;
  kind: ArenaInfo['kind'];
  reason: string;
  at: string;
}

/** How many refused builds the school view lists, newest first. */
const REFUSALS_SHOWN = 10;

/** Records and emits a refused build with its reason in plain words. */
function refuseBuild(repo: string, kind: ArenaInfo['kind'], reason: string): void {
  const data: ArenaRefusal = { repo, kind, reason, at: new Date().toISOString() };
  record('arena.refused', data);
  emit('arena.refused', { ...data });
}

/** The newest refused builds, read newest first from the ledger (one indexed read, bounded). */
function arenaRefusals(): ArenaRefusal[] {
  const rows = openDb().prepare("SELECT json FROM ledger WHERE kind = 'arena.refused' ORDER BY id DESC LIMIT ?").all(REFUSALS_SHOWN) as Array<{ json: string }>;
  const out: ArenaRefusal[] = [];
  for (const r of rows) {
    try {
      const d = JSON.parse(r.json) as ArenaRefusal;
      if (d && typeof d.repo === 'string' && typeof d.reason === 'string') out.push(d);
    } catch {
      // a row that cannot be read is left out
    }
  }
  return out;
}

/**
 * Starts an arena build in the background, stopped when the school is turned
 * off. A build the engine refuses as it starts (another build running, a
 * graduation race holding the machine, the repo changed since the route
 * checked it) answers an arena with no id: that, or a build that throws, is
 * recorded and emitted as `arena.refused` with the reason, so the school view
 * says why nothing was built.
 */
function startBuild(kind: ArenaInfo['kind'], fullName: string): Promise<void> {
  const repo = getRepo(fullName)!;
  const ctl = new AbortController();
  const unregister = registerAbort(() => ctl.abort());
  const build = kind === 'planted' ? buildPlanted : buildPast;
  return build(repo, Date.now(), { signal: ctl.signal })
    .then(
      (info) => {
        if (!info.id && info.status === 'failed') refuseBuild(fullName, kind, info.reason ?? 'The build was refused');
      },
      (err: unknown) => refuseBuild(fullName, kind, `The build stopped: ${err instanceof Error ? err.message : String(err)}`),
    )
    .finally(unregister);
}

/** The newest build started from a route, for tests to wait on. */
let lastBuild: Promise<void> = Promise.resolve();

/** Resolves when the newest build a route started has ended or been refused (tests). */
export function buildSettled(): Promise<void> {
  return lastBuild;
}

/**
 * Answers the school's routes (and his autonomy moves). Returns false for a
 * path it does not own; throws HttpError for a refused input.
 */
export async function handleSchoolApi(req: IncomingMessage, pathname: string, method: string, send: Send): Promise<boolean> {
  const out = (status: number, body: unknown): true => send(status, schoolScrub(body));
  let m: RegExpMatchArray | null;

  if (pathname === '/api/school' && method === 'GET') return out(200, await schoolView());
  // The university's plot, where the city draws the campus (Task 1), with what is under way there.
  if (pathname === '/api/school/campus' && method === 'GET') return out(200, campusView());
  if ((m = pathname.match(/^\/api\/school\/nets\/([^/]+)$/)) && method === 'GET') {
    const net = netOf(m[1]);
    const strip = ({ path: _path, ...v }: NetVersion) => v;
    return out(200, { ...netCard(net, Date.now()), versions: versions(net).map(strip) });
  }
  if ((m = pathname.match(/^\/api\/school\/voyages\/([^/]+)$/)) && method === 'GET') {
    const v = voyage(idOf(m[1], 'voyage'));
    if (!v) throw new HttpError(404, { error: 'unknown voyage' });
    return out(200, voyageOut(v));
  }
  if ((m = pathname.match(/^\/api\/school\/graduates\/([^/]+)$/)) && method === 'GET') {
    const id = idOf(m[1], 'graduate');
    const g = graduates().find((x) => x.id === id);
    if (!g) throw new HttpError(404, { error: 'unknown graduate' });
    return out(200, g);
  }

  if (pathname === '/api/school/train-now' && method === 'POST') {
    const r = await startTrainNow(Date.now());
    if (!r.ok) throw new HttpError(409, { error: r.reason });
    return out(200, { until: r.until });
  }
  if (pathname === '/api/school/train-now' && method === 'DELETE') {
    stopTrainNow();
    return out(200, { until: null });
  }
  if (pathname === '/api/school/download-base' && method === 'POST') {
    const r = startDownload();
    return out(r.status === 'ready' ? 200 : 202, r);
  }
  if ((m = pathname.match(/^\/api\/school\/arenas\/([^/]+)\/([^/]+)$/)) && method === 'POST') {
    const full = repoOf(m[1], m[2]);
    const body = await readJsonBody(req);
    const kind = (body as { kind?: unknown } | null)?.kind;
    if (kind !== 'planted' && kind !== 'past') throw new HttpError(400, { error: 'expected { kind: "planted" | "past" }' });
    const repo = getRepo(full);
    if (!repo) throw new HttpError(404, { error: 'unknown repo' });
    const why = refusal(repo);
    if (why) throw new HttpError(409, { error: why });
    lastBuild = startBuild(kind, full);
    return out(202, { repo: full, kind, status: 'building' });
  }

  if ((m = pathname.match(/^\/api\/autonomy\/([^/]+)\/([^/]+)\/([^/]+)\/(grant|decline|revoke)$/)) && method === 'POST') {
    const kind = kindOf(m[1]);
    const repo = repoOf(m[2], m[3]);
    const body = await readJsonBody(req);
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, { error: 'expected a JSON object' });
    const b = body as Record<string, unknown>;
    if (Object.keys(b).some((k) => k !== 'fromSettings') || ('fromSettings' in b && typeof b.fromSettings !== 'boolean')) throw new HttpError(400, { error: 'expected { fromSettings?: boolean }' });
    const now = Date.now();
    if (m[4] === 'grant') return out(200, refusing(() => grant(kind, repo, now, { fromSettings: b.fromSettings === true })));
    if (m[4] === 'decline') return out(200, refusing(() => decline(kind, repo, now)));
    return out(200, refusing(() => revoke(kind, repo, 'him', null, now)));
  }

  return false;
}
