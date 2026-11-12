/**
 * The exterior lift ride up a tower (Task 35), as pure numbers: where the
 * ride stops, how long it takes between stops and what each stop says.
 * The city (app/src/city/ride.ts) turns the plan into a car on the facade
 * and a camera riding beside it; nothing here knows about either.
 *
 * Heights are eye heights: the eye stands EYE metres over the car's floor.
 * The car climbs three floors a second, slowing to 0.8 a second over the
 * datum, over a scar and over Claude's floors, and waits a beat at each with
 * a caption. It ends over the roof (over the crown of an agent's tower) with
 * a slow orbit, or at the live work when a site is under construction.
 */
import type { Award, Bid, Floor, InspectionView, Job, RunView, SiteState } from './types.js';
import type { TowerLayout } from './tower-layout.js';

export const RIDE = {
  /** Floors a second at cruise. */
  speed: 3,
  /** A ride longer than this many seconds climbs faster at cruise... */
  longest: 45,
  /** ...up to this many floors a second. */
  fastest: 6,
  /** Floors a second over the datum, a scar and Claude's floors. */
  slow: 0.8,
  /** Seconds the car waits at a captioned floor. */
  dwell: 1.2,
  /** Seconds it waits at a floor with a dossier: long enough to read two short lines, not a stall. */
  dossierDwell: 2.4,
  /** At most this many floors of a tower carry a dossier on the ride. */
  dossiers: 6,
  /** Seconds at street level before the car moves off. */
  start: 1.6,
  /** Seconds of the slow orbit over the roof. */
  orbit: 6,
  /** Seconds the ride waits at the live work. */
  live: 6,
  /** Seconds a caption stays after the car moves on. */
  hold: 2.2,
  /** The eye over the car's floor, in metres. */
  eye: 1.6,
  /** How far below a floor's middle the car stops, so the eye looks a little up at it. */
  under: 0.9,
  /** A run of Claude floors this close together is one passage: the car waits at its first floor and slows through the rest. */
  passageGap: 3,
  /** The metres a "floor" of the root counts for, at cruise. */
  rootFloor: 4.2,
  /** Half the width, in seconds, of the window the eye's height is averaged over: the car eases into and out of every stop. */
  ease: 0.32,
} as const;

export type RideMark = 'datum' | 'scar' | 'claude' | 'live' | null;

export interface RideCaption {
  title: string;
  date: string;
  who: string;
  mark: RideMark;
  /** What is inside an earned floor (Phase 3 Task 18), or null. */
  dossier?: Dossier | null;
}

/**
 * The floor dossier (Phase 3 Task 18, Decision 6): what is inside an
 * earned floor, set small under its caption as the car waits there: the
 * change in numbers, the agent's plan, the inspection's verdict, the README
 * claim behind a proposal, and the firm. Every string is cleaned and cut.
 */
export interface Dossier {
  diff: { files: number; lines: number } | null;
  plan: string | null;
  verdict: string | null;
  claim: string | null;
  firm: string | null;
}

/** What the dossier is read from: the job's detail and its run's inspection (the API's, redacted), the finding's claim. */
export interface DossierData {
  job?: Job | null;
  bids?: Bid[];
  award?: Award | null;
  run?: RunView | null;
  inspection?: InspectionView | null;
  claim?: string | null;
  firm?: string | null;
  /** The page's own redaction (app/src/ui/detail.ts redactLog), run on every string before it is cleaned. */
  redact?: (s: string) => string;
}

/** A line of model or engine text made safe to set in the city: one line, no control characters, cut at a word. */
export function dossierText(text: string | null | undefined, max = 160): string | null {
  if (!text) return null;
  // Bidi overrides and isolates, zero-width marks and the byte-order mark go first (they could turn a line round or hide
  // what it says), then control characters become spaces.
  // eslint-disable-next-line no-control-regex
  const one = text.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!one) return null;
  if (one.length <= max) return one;
  const cut = one.slice(0, max - 1);
  const at = cut.lastIndexOf(' ');
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, '')}\u2026`;
}

/** An earned floor's dossier, or null for a founding floor or one whose job has not been read. */
export function dossierOf(floor: Floor, data: DossierData | null): Dossier | null {
  const e = floor.earned;
  if (floor.founding || !e || !data) return null;
  const run = data.run ?? null;
  const bid = (run ? data.bids?.find((b) => b.id === run.bidId) : undefined) ?? data.award?.chosen ?? data.bids?.find((b) => b.agentId === e.agentId) ?? null;
  const insp = data.inspection ?? null;
  let verdict: string | null = null;
  if (insp) {
    if (insp.inconclusive) verdict = 'Inconclusive';
    else if (insp.passed) verdict = insp.pushable ? 'Passed, pushable' : 'Passed, held back';
    else {
      const failed = insp.checks.filter((c) => c.status === 'fail').map((c) => c.name);
      verdict = failed.length ? `Failed: ${failed.join(', ')}` : 'Failed';
    }
  }
  const files = run?.progress?.filesChanged ?? 0;
  const red = (t: string | null | undefined): string | null => (t ? (data.redact ? data.redact(t) : t) : null);
  return {
    diff: files > 0 || floor.lines > 0 ? { files, lines: floor.lines } : null,
    plan: dossierText(red(bid?.plan ?? run?.summary ?? null)),
    verdict,
    claim: data.job?.source === 'proposal' ? dossierText(red(data.claim), 120) : null,
    firm: dossierText(red(data.firm), 60),
  };
}

/** The dossier in words, as the caption sets it: "4 files, 212 lines. Plan: add the retry. Passed, pushable." and the claim. */
export function dossierWords(d: Dossier): { line: string; claim: string | null } {
  const diff = d.diff ? `${d.diff.files ? `${plural(d.diff.files, 'file')}, ` : ''}${plural(d.diff.lines, 'line')}.` : null;
  const line = [diff, planLine(d.plan), d.verdict ? `${d.verdict}.` : null].filter(Boolean).join(' ');
  return { line, claim: d.claim ? `From the README: \u2018${d.claim}\u2019` : null };
}

/** The plan set inside a sentence: "Plan: " and its first letter lowered, unless it starts an acronym or a name in capitals. */
function planLine(plan: string | null): string | null {
  if (!plan) return null;
  const p = /^[A-Z][a-z]/.test(plan) ? plan[0].toLowerCase() + plan.slice(1) : plan;
  return `Plan: ${p}${/[.!?\u2026]$/.test(p) ? '' : '.'}`;
}

/** The dossier as the caption lays it out: the facts (the change and the verdict), the plan, and the claim, each its own line. */
export function dossierParts(d: Dossier): { facts: string | null; plan: string | null; claim: string | null; verdict: 'pass' | 'fail' | 'open' | null } {
  const facts: string[] = [];
  if (d.diff) facts.push(`${d.diff.files ? `${plural(d.diff.files, 'file')}, ` : ''}${plural(d.diff.lines, 'line')}.`);
  if (d.verdict) facts.push(`${d.verdict}.`);
  return {
    facts: facts.length ? facts.join(' ') : null,
    plan: planLine(d.plan),
    claim: dossierWords(d).claim,
    verdict: d.verdict ? (d.verdict.startsWith('Passed') ? 'pass' : d.verdict.startsWith('Failed') ? 'fail' : 'open') : null,
  };
}

/**
 * The floors of a tower that carry a dossier on the ride, at most
 * RIDE.dossiers: the newest two earned floors always (what he most likely
 * rides up to see), then the scars and the floors a proposal built (its job
 * id in `proposals`), newest first, then the third newest; never a founding
 * floor. In the order they were picked.
 */
export function dossierFloors(floors: ReadonlyArray<Floor>, proposals: ReadonlySet<string> = new Set()): string[] {
  const newest = floors.filter((f) => !f.founding && f.earned).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  const out: string[] = [];
  const add = (f: Floor): void => {
    if (out.length < RIDE.dossiers && !out.includes(f.id)) out.push(f.id);
  };
  for (const f of newest.slice(0, 2)) add(f);
  for (const f of newest) if (f.earned!.state === 'scar' || proposals.has(f.earned!.jobId)) add(f);
  for (const f of newest.slice(2, 3)) add(f);
  return out;
}

export interface RideKey {
  /** Seconds from the start when the eye reaches `y`. */
  t: number;
  /** The eye's height, in metres. */
  y: number;
  /** Seconds the car waits here before moving on. */
  dwell: number;
  caption: RideCaption | null;
  /** The floor this stop shows (the hook a floor's own content hangs from), or null. */
  floorId: string | null;
}

export interface RideNames {
  agents: Map<string, string>;
  firms: Map<string, string>;
}

export interface RideOptions {
  /** The site at work on this tower, if any. */
  live: SiteState | null;
  names?: RideNames;
  /** The tower's short name, for the roof's caption. */
  name?: string;
  /** The root's caption, as the inspector names it ("Beaux-Arts root"). */
  root?: string;
  /** The crown's height over the roof (an agent's lens or spire), in metres. */
  crown?: number;
  /** An agent's tower: the datum is where the agent joined the city. */
  agent?: boolean;
  /** Earned floors with a dossier, by floor id: each is a stop the car waits longer at, the dossier under its caption. */
  dossiers?: ReadonlyMap<string, Dossier>;
}

/** The site stages at which there is work to ride up to. */
const AT_WORK = new Set(['crane', 'framing', 'inspecting', 'curing']);

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** A floor's date as the inspector prints it ("Mar 4, 2025"), or '' when it cannot be read. */
export function rideDate(at: string): string {
  const t = Date.parse(at);
  return Number.isFinite(t) ? dateFormat.format(t) : '';
}

const SCAR_PREFIX = /^Failed inspection:\s*/;
const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

interface Stop {
  y: number;
  dwell: number;
  caption: RideCaption | null;
  floorId: string | null;
}

/**
 * The ride up a tower laid out by `layout`, floor by floor (`floors` oldest
 * first, as the layout stacks them): the stops, and a key wherever the
 * car's speed changes between them, so that the eye's height is linear in
 * time from one key to the next (after each key's dwell).
 */
export function ridePlan(layout: TowerLayout, floors: Floor[], opts: RideOptions): RideKey[] {
  const keys = planAt(layout, floors, opts, RIDE.speed);
  if (rideLength(keys) <= RIDE.longest) return keys;
  // Too long at three floors a second: the cruise alone quickens (the stops and the slow floors keep their pace),
  // as little as brings the ride within its length, and never past six floors a second.
  const top = planAt(layout, floors, opts, RIDE.fastest);
  if (rideLength(top) >= RIDE.longest) return top;
  let lo: number = RIDE.speed;
  let hi: number = RIDE.fastest;
  let best = top;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const k = planAt(layout, floors, opts, mid);
    if (rideLength(k) <= RIDE.longest) {
      hi = mid;
      best = k;
    } else lo = mid;
  }
  return best;
}

/** The ride at a cruise of `speed` floors a second. */
function planAt(layout: TowerLayout, floors: Floor[], opts: RideOptions, speed: number): RideKey[] {
  void floors;
  const names = opts.names;
  const nameOf = (m: Map<string, string> | undefined, id: string): string => m?.get(id) ?? id;
  const laid = layout.floors;
  const has = laid.length > 0;
  const datumIndex = has ? laid.findIndex((l) => !l.floor.founding) : -1;
  // The datum sits under the first earned floor, or over the last founding floor when none was earned.
  const datumAt = has ? (datumIndex >= 0 ? datumIndex : laid.length) : -1;

  // ---------------------------------------------------------------- where the car goes slowly
  const slow: Array<[number, number]> = [];
  if (has) {
    const below = laid[datumAt - 1];
    const above = laid[datumAt];
    slow.push([layout.datumY - (below ? below.h / 2 : 0), layout.datumY + (above ? above.h / 2 : 0)]);
  }
  const markOf = (f: Floor): RideMark => (f.earned?.state === 'scar' ? 'scar' : f.founding && f.claude ? 'claude' : null);
  laid.forEach((l) => {
    if (markOf(l.floor)) slow.push([l.y0, l.y0 + l.h]);
  });
  const isSlow = (y: number): boolean => slow.some(([a, b]) => y >= a - 1e-9 && y < b - 1e-9);
  /** Metres a second at a height: the floor there sets what three floors a second is. */
  const rate = (y: number): number => {
    const l = laid.find((x) => y >= x.y0 - 1e-9 && y < x.y0 + x.h - 1e-9);
    const h = l ? l.h : RIDE.rootFloor;
    return (isSlow(y) ? RIDE.slow : speed) * h;
  };

  // ---------------------------------------------------------------- the stops
  const stops: Stop[] = [{ y: RIDE.eye, dwell: RIDE.start, caption: { title: opts.root ?? 'The root', date: '', who: 'inherited', mark: null }, floorId: null }];
  const floorCaption = (f: Floor, mark: RideMark): RideCaption => {
    const e = f.earned;
    const who = e ? `${nameOf(names?.agents, e.agentId)}, ${nameOf(names?.firms, e.firmId)}` : f.claude ? 'with Claude' : (f.refs[0] ?? '');
    return { title: f.title.replace(SCAR_PREFIX, ''), date: rideDate(f.at), who, mark };
  };
  let lastClaude = -Infinity;
  laid.forEach((l, i) => {
    const mark = markOf(l.floor);
    const dossier = opts.dossiers?.get(l.floor.id) ?? null;
    if (dossier) {
      // A floor with a dossier: a stop of its own, waited at long enough to read it.
      const y = Math.max(RIDE.eye, l.y0 + l.h / 2 - RIDE.under);
      stops.push({ y, dwell: RIDE.dossierDwell, caption: { ...floorCaption(l.floor, mark), dossier }, floorId: l.floor.id });
      return;
    }
    if (!mark) return;
    const y = Math.max(RIDE.eye, l.y0 + l.h / 2 - RIDE.under);
    if (mark === 'claude') {
      // A passage of Claude floors: the car waits at its first floor and reads the rest as it slows past them.
      const first = i - lastClaude > RIDE.passageGap;
      lastClaude = i;
      stops.push({ y, dwell: first ? RIDE.dwell : 0, caption: floorCaption(l.floor, mark), floorId: l.floor.id });
      return;
    }
    stops.push({ y, dwell: RIDE.dwell, caption: floorCaption(l.floor, mark), floorId: l.floor.id });
  });
  if (has) {
    const first = laid[datumAt]?.floor ?? laid[datumAt - 1].floor;
    stops.push({
      y: Math.max(RIDE.eye, layout.datumY - RIDE.under),
      dwell: RIDE.dwell,
      caption: { title: 'Datum line', date: rideDate(first.at), who: opts.agent ? 'where the agent joined the city' : 'where the repo joined the city', mark: 'datum' },
      floorId: null,
    });
  }

  const live = opts.live && AT_WORK.has(opts.live.stage) ? opts.live : null;
  const top = laid.length ? laid[laid.length - 1].floor : null;
  if (live) {
    const own = laid.findIndex((l) => l.floor.earned?.runId === live.runId);
    const n = own >= 0 ? own + 1 : laid.length + 1;
    const agent = nameOf(names?.agents, live.agentId);
    const title =
      live.stage === 'inspecting' ? `${agent}’s floor ${n} is under inspection` : live.stage === 'curing' ? `${agent}’s floor ${n} is curing` : `${agent} is framing floor ${n}`;
    stops.push({ y: layout.top + RIDE.eye, dwell: RIDE.live, caption: { title, date: rideDate(live.since), who: nameOf(names?.firms, live.firmId), mark: 'live' }, floorId: own >= 0 ? laid[own].floor.id : null });
  } else {
    stops.push({
      y: layout.top + Math.max(RIDE.eye, (opts.crown ?? 0) * 0.6),
      dwell: RIDE.orbit,
      caption: { title: opts.name ?? 'The roof', date: top ? rideDate(top.at) : '', who: has ? `${plural(laid.length, 'floor')} over the root` : 'root only', mark: null },
      floorId: null,
    });
  }
  // In order up the tower; at one height, the stops keep the order they were found in.
  const ordered = stops.map((s, i) => ({ s, i })).sort((a, b) => a.s.y - b.s.y || a.i - b.i).map((x) => x.s);

  // ---------------------------------------------------------------- timing
  // Every height where the speed may change, between the first stop and the last.
  const y0 = ordered[0].y;
  const y1 = ordered[ordered.length - 1].y;
  const marks = new Set<number>();
  for (const l of laid) marks.add(l.y0).add(l.y0 + l.h);
  marks.add(layout.rootHeight);
  for (const [a, b] of slow) marks.add(a).add(b);
  const breaks = [...marks].filter((y) => y > y0 + 1e-9 && y < y1 - 1e-9).sort((a, b) => a - b);

  const keys: RideKey[] = [];
  let t = 0;
  let y = y0;
  let si = 0;
  let bi = 0;
  const push = (s: Stop | null): void => {
    keys.push({ t, y, dwell: s?.dwell ?? 0, caption: s?.caption ?? null, floorId: s?.floorId ?? null });
    t += s?.dwell ?? 0;
  };
  // The first stop.
  push(ordered[si++]);
  while (si < ordered.length) {
    const next = ordered[si];
    const nb = bi < breaks.length ? breaks[bi] : Infinity;
    if (nb < next.y - 1e-9) {
      // A change of speed before the next stop: a key there, when the speed really changes.
      t += (nb - y) / rate((y + nb) / 2);
      y = nb;
      bi++;
      const before = keys[keys.length - 1];
      const speedBefore = (y - before.y) / Math.max(1e-9, t - before.t - before.dwell);
      const after = rate(y + 1e-6);
      if (Math.abs(after - speedBefore) > 1e-6) push(null);
      continue;
    }
    t += (next.y - y) / rate((y + next.y) / 2 || y);
    y = next.y;
    while (bi < breaks.length && breaks[bi] <= y + 1e-9) bi++;
    // A key that only marked a speed change at this height gives way to the stop.
    const last = keys[keys.length - 1];
    if (last && !last.caption && last.dwell === 0 && Math.abs(last.y - y) < 1e-9 && keys.length > 1) keys.pop();
    push(next);
    si++;
  }
  return keys;
}

// ---------------------------------------------------------------- reading a plan

/** The eye's height before smoothing: held through each dwell, linear between keys. */
function yLinear(keys: RideKey[], t: number): number {
  if (t <= keys[0].t) return keys[0].y;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const leave = k.t + k.dwell;
    if (t <= leave) return k.y;
    const n = keys[i + 1];
    if (!n) return k.y;
    if (t < n.t) return k.y + ((n.y - k.y) * (t - leave)) / Math.max(1e-9, n.t - leave);
  }
  return keys[keys.length - 1].y;
}

/** The integral of yLinear from the first key to t (t may lie before it or after the last). */
function yIntegral(keys: RideKey[], t: number): number {
  const t0 = keys[0].t;
  if (t <= t0) return keys[0].y * (t - t0);
  let s = 0;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const leave = k.t + k.dwell;
    // The dwell.
    s += k.y * (Math.min(t, leave) - k.t);
    if (t <= leave) return s;
    const n = keys[i + 1];
    if (!n) return s + k.y * (t - leave);
    // The climb to the next key: a trapezoid, cut at t.
    const e = Math.min(t, n.t);
    const ye = yLinear(keys, e);
    s += ((k.y + ye) / 2) * (e - leave);
    if (t <= n.t) return s;
  }
  return s;
}

/** When the car reaches the next stop after `t` (a key it waits at), or null past the last: Space and Right skip there. */
export function rideNextStop(keys: RideKey[], t: number): number | null {
  for (const k of keys) if (k.dwell > 0 && k.t > t + 1e-6) return k.t;
  return null;
}

/** When the ride is over: the last key's dwell is done. */
export function rideLength(keys: RideKey[]): number {
  const last = keys[keys.length - 1];
  return last.t + last.dwell;
}

export interface RideNow {
  /** The eye's height, eased into and out of every stop. */
  y: number;
  /** Metres a second, up. */
  v: number;
  /** The key last reached (its index). */
  key: number;
  /** True while the car waits at a stop. */
  dwelling: boolean;
  /** The caption showing now, and the key it belongs to. */
  caption: RideCaption | null;
  captionKey: number;
  /** The ride is over. */
  done: boolean;
}

/** Where the ride stands `t` seconds in. */
export function rideAt(keys: RideKey[], t: number): RideNow {
  const e = RIDE.ease;
  const y = (yIntegral(keys, t + e) - yIntegral(keys, t - e)) / (2 * e);
  const v = (yLinear(keys, t + e) - yLinear(keys, t - e)) / (2 * e);
  let key = 0;
  for (let i = 0; i < keys.length; i++) if (keys[i].t <= t + 1e-9) key = i;
  const k = keys[key];
  const dwelling = k.dwell > 0 && t >= k.t - 1e-9 && t <= k.t + k.dwell;
  let captionKey = -1;
  for (let i = key; i >= 0; i--) {
    if (keys[i].caption) {
      captionKey = i;
      break;
    }
  }
  const c = captionKey >= 0 ? keys[captionKey] : null;
  const last = captionKey === keys.length - 1;
  const showing = c && (last || t <= c.t + c.dwell + RIDE.hold) ? c.caption : null;
  return { y, v, key, dwelling, caption: showing, captionKey: showing ? captionKey : -1, done: t >= rideLength(keys) };
}

/**
 * The car settling on its ropes after it stops and as it pulls away: a small
 * bounce (metres) and roll (radians), dying away in a second or so.
 */
export function rideSway(keys: RideKey[], t: number): { bounce: number; roll: number } {
  let bounce = 0;
  let roll = 0;
  for (const k of keys) {
    if (k.dwell <= 0) continue;
    for (const [at, a] of [
      [k.t + RIDE.ease * 0.6, 1],
      [k.t + k.dwell + RIDE.ease * 0.4, 0.45],
    ] as Array<[number, number]>) {
      const s = t - at;
      if (s < 0 || s > 4) continue;
      const fall = Math.exp(-s / 0.55) * a;
      bounce += 0.028 * fall * Math.sin(2 * Math.PI * 1.7 * s);
      roll += 0.0026 * fall * Math.sin(2 * Math.PI * 0.9 * s + 0.6);
    }
  }
  return { bounce, roll };
}
