/**
 * Persona trips (Task 33): where the firms' people go when the market
 * really moves them. An agent walks or rides to the exchange when it bids,
 * on to the job's district when it wins, to the site when it inspects
 * another firm's change, and home to its quarter when its run ends. The
 * legs come from shared/commute.ts's router over the same network the
 * city draws, so the app's vehicles can board them.
 *
 * An agent has at most one trip under way: a new one ends the old
 * (`superseded`). A trip whose time is up ends `arrived` the next time the
 * live trips are asked for. A bankrupt firm's trips end at once (the
 * treasury). Every trip is stored, recorded (`trip.started`,
 * `trip.ended`) and emitted.
 */
import { randomUUID } from 'node:crypto';

import { extentBlocks, network, route, type Network } from '../../shared/commute.js';
import type { Agent, Run, Trip, TripReason } from '../../shared/types.js';
import { openDb } from '../db.js';
import { emit } from '../events.js';
import { districtOrigin, quarterOrigin } from '../layout.js';
import { record } from '../ledger.js';
import { getRepo, listRepos } from '../repos.js';
import { agent as storedAgent, firm, listFirms } from './firms.js';
import { redact } from './jobs.js';

type P = { x: number; z: number };

const iso = (ms: number) => new Date(ms).toISOString();

/** Where a bidder stands at the exchange: the hall's forecourt, south of the civic centre. */
export const EXCHANGE: P = { x: 0, z: 40 };

/** Where a firm's person stands at home: beside its tower in the quarter. */
export function homeOf(a: Pick<Agent, 'firmId' | 'towerIndex'>): P {
  const q = quarterOrigin(firm(a.firmId)?.slot ?? 0);
  return { x: q.x + (a.towerIndex % 2 ? 30 : -30), z: q.z + (a.towerIndex < 2 ? -30 : 30) };
}

/** Where a job's site is: in the repo's district, off the plaza. */
export function siteOf(repo: string): P {
  const o = districtOrigin(getRepo(repo)?.slot ?? 0);
  return { x: o.x + 40, z: o.z + 40 };
}

/** Where an agent is now: the end of its latest trip, or home when it has never travelled. */
export function whereIs(a: Agent): P {
  const latest = storedTrips()
    .filter((t) => t.agentId === a.id)
    .sort((x, y) => x.startedAt.localeCompare(y.startedAt))
    .at(-1);
  return latest ? latest.to : homeOf(a);
}

let net: Network | null = null;
let netKey = '';

/** The network as the city lays it: round every district and quarter, a rank at each district's plaza. */
function currentNetwork(): Network {
  const districts = listRepos().map((r) => districtOrigin(r.slot));
  const quarters = listFirms().map((f) => quarterOrigin(f.slot));
  const standing = [...districts, ...quarters];
  const extent = { blocks: extentBlocks(standing.length ? standing : [EXCHANGE]), districts };
  const key = JSON.stringify(extent);
  if (!net || key !== netKey) {
    net = network(extent);
    netKey = key;
  }
  return net;
}

function storedTrips(): Trip[] {
  return (openDb().prepare('SELECT json FROM trips').all() as Array<{ json: string }>).map((r) => JSON.parse(r.json) as Trip);
}

function save(t: Trip): void {
  openDb().prepare('INSERT OR REPLACE INTO trips (id, json) VALUES (?, ?)').run(t.id, JSON.stringify(t));
}

/** Every stored trip not yet ended, whether or not its time is up. */
export function liveTrips(): Trip[] {
  return storedTrips().filter((t) => !t.endedAt);
}

export interface TripOptions {
  /** Scales every leg's time (the sample clock runs faster than the world). */
  msScale?: number;
  /** Carries the events: the treasury defers them until its atomic block has written. */
  announce?: (type: string, data: object) => void;
}

/**
 * Starts `a`'s trip from `from` to `to`, routed over the city's network,
 * ending any trip it already had. Records and emits `trip.started`.
 */
export function startTrip(a: Agent, reason: TripReason, jobId: string | null, from: P, to: P, now: number = Date.now(), opts: TripOptions = {}): Trip {
  const announce = opts.announce ?? emit;
  for (const old of liveTrips()) if (old.agentId === a.id) endTrip(old.id, 'superseded', now, announce);
  const scale = opts.msScale ?? 1;
  const legs = route(from, to, currentNetwork()).map((l) => ({ ...l, ms: Math.max(1, Math.round(l.ms * scale)) }));
  const trip: Trip = {
    id: `trip-${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    agentId: a.id,
    firmId: a.firmId,
    reason,
    jobId,
    from: { x: from.x, z: from.z },
    to: { x: to.x, z: to.z },
    legs,
    startedAt: iso(now),
    ms: legs.reduce((s, l) => s + l.ms, 0),
    endedAt: null,
  };
  save(trip);
  record('trip.started', { tripId: trip.id, agentId: a.id, firmId: a.firmId, jobId, trip });
  announce('trip.started', { trip });
  return trip;
}

/** Ends a trip for `why` (redacted). Records and emits `trip.ended`. Null when there is no such live trip. */
export function endTrip(tripId: string, why: string, now: number = Date.now(), announce: (type: string, data: object) => void = emit): Trip | null {
  const t = storedTrips().find((x) => x.id === tripId);
  if (!t || t.endedAt) return null;
  const ended: Trip = { ...t, endedAt: iso(now) };
  save(ended);
  const data = { tripId: t.id, agentId: t.agentId, firmId: t.firmId, reason: redact(why), at: iso(now) };
  record('trip.ended', data);
  announce('trip.ended', data);
  return ended;
}

/** Ends every live trip of a firm's people, or of one agent. */
export function endTripsOf(who: { firmId?: string; agentId?: string }, why: string, now: number = Date.now(), announce: (type: string, data: object) => void = emit): Trip[] {
  const out: Trip[] = [];
  for (const t of liveTrips()) {
    if (who.firmId !== undefined && t.firmId !== who.firmId) continue;
    if (who.agentId !== undefined && t.agentId !== who.agentId) continue;
    const ended = endTrip(t.id, why, now, announce);
    if (ended) out.push(ended);
  }
  return out;
}

/** The trips under way at `now`. A trip whose time is up ends `arrived` here, before the rest are answered. */
export function activeTrips(now: number = Date.now()): Trip[] {
  const out: Trip[] = [];
  for (const t of liveTrips()) {
    if (Date.parse(t.startedAt) + t.ms <= now) endTrip(t.id, 'arrived', now);
    else out.push(t);
  }
  return out;
}

/** The worker goes home from the site when its run ends. Nothing when the agent is gone. */
export function sendHome(r: Pick<Run, 'agentId' | 'repo' | 'jobId'>, now: number = Date.now()): Trip | null {
  const a = storedAgent(r.agentId);
  if (!a || a.retired) return null;
  return startTrip(a, 'home', r.jobId, siteOf(r.repo), homeOf(a), now);
}
