import * as THREE from 'three';

import './ui/style.css';
import './ui/screens.css';

import type { Agent, District, FirmView, Job, Quarter, Repo, SiteState, TowerSpec } from '../../shared/types';
import { api } from './api';
import { coalesced } from './coalesce';
import type { Plate } from './city/labels';
import { boardLabel, type BoardJob, type BoardSlot, JOBS_ROUTE, makeExchange } from './city/exchange';
import { occupancy, type RepoState } from './city/occupancy.js';
import { quarterCenterpiece, quarterLooks } from './city/quarters';
import { createCity, type PickHit } from './city/scene';
import type { VehicleRef, VehiclesView } from './city/vehicles.js';
import type { AmbientView } from './city/ambient.js';
import { route } from '../../shared/commute.js';
import type { Trip } from '../../shared/types';
import { towerCenterpiece, towerMaterials } from './city/tower/look';
import { firmMarkColor } from './city/tower/eras';
import { cleanText } from './ui/board';
import type { FigureView, PeopleView } from './city/people.js';
import { type SwatchPoint, swatchBoard } from './city/tower/swatches';
import { ambientBoard, type AmbientSwatchPoint } from './city/ambient-swatches';
import { towerTones } from './city/lots';
import { loadKits, registerFallbackKits } from './city/kits';
import { texturesSettled } from './city/materials';
import { type Look, lookFor, lookKey, pickLooks, VARIANTS } from './city/tower/variants';
import type { EngineEvent } from './api';
import { navigate, onRoute } from './router';
import { createInspector, ROOT_NAMES, type MarketNames } from './ui/inspector';
import { startRide, type Ride, type RideState } from './city/ride';
import { ridePlan } from '../../shared/ride.js';
import { layoutTower } from '../../shared/tower-layout.js';
import { crownFor } from '../../shared/silhouette.js';
import { createAgentPage } from './ui/agent';
import { createFirmPage } from './ui/firm';
import { createFirms } from './ui/firms';
import { createTreasury } from './ui/treasury';
import { createInspectionPage } from './ui/inspection';
import { createJobPage } from './ui/job';
import { createJobs } from './ui/jobs';
import { createRunPage } from './ui/run';
import { createDistrictPage } from './ui/repo';
import { createRepos } from './ui/repos';
import { createRunhead } from './ui/runhead';
import { createSettings } from './ui/settings';

/** A vehicle as the debug handle reports it. */
interface VehicleProbe {
  id: string;
  kind: string;
  position: number[];
  heading: number;
  speed: number;
  floorY: number;
  phase: string;
}
const probe = (r: VehicleRef): VehicleProbe => ({ id: r.id, kind: r.kind, position: r.position(), heading: r.heading(), speed: r.speed(), floorY: r.floorY(), phase: r.phase() });

interface DebugHandle {
  ready: boolean;
  districts: number;
  /** Scaffolds standing at analyzing sites. */
  sites: number;
  /** Districts built since load: a refresh rebuilds only what changed. */
  builds: number;
  lastPick: PickHit | null;
  /** Opens the inspector on a repo's tower, as clicking its plate does. */
  inspect(repo: string): void;
  /** Opens an agent's page and comes to its tower, as clicking the tower does. */
  openAgent(agentId: string): void;
  highlight: { repo: string; floorId: string } | null;
  view(eye: number[], target: number[]): void;
  camera(): number[];
  /** Glides back to the home framing, as the H key does. */
  home(): void;
  /** The view's limits now, as eased this frame. */
  limits(): ReturnType<ReturnType<typeof createCity>['limits']>;
  /** Where a world point lands on screen, in normalised device coordinates (y up, the frame is -1 to 1). */
  project(p: number[]): number[];
  precompile(): Promise<void>;
  stats(): { calls: number; triangles: number };
  /** The next frame's draw calls and triangles by subsystem and pass, the shadow map redrawn in it. */
  breakdown(detail?: boolean): ReturnType<ReturnType<typeof createCity>['breakdown']>;
  /** The river's lanterns, its static draw calls and whether its water drew since last asked. */
  river(): { lamps: number; meshes: number; triangles: number; drewWater: boolean; steps: number; colourScale: number };
  /** The transit network: what of it draws from this camera, and how many stops, stations, poles, bents, pylons and ranks stand. */
  transit(): ReturnType<ReturnType<typeof createCity>['transit']>;
  /** The vehicles: how many run, and what of them draws from this camera (null before the network is laid). */
  vehicles(): VehiclesView | null;
  /** Holds or releases the vehicles' clock, or moves it on (captures and tests). */
  vehicleHold(on: boolean): void;
  vehicleSkip(seconds: number): void;
  /** Moves the clock on until a vehicle of the kind stands at a stop (the one nearest `near`): where it stands and which way it faces. */
  vehicleStage(kind: 'tram' | 'rail' | 'pod' | 'ferry', near?: number[]): VehicleProbe | null;
  /** Rides a synthetic trip from one point to another: each leg's vehicle (a cab summoned for a cab leg), and when it boards and alights. */
  vehicleTrip(from: number[], to: number[]): Array<{ mode: string; id: string | null; boardsIn: number; alightsIn: number }>;
  /** Moves the vehicles' clock on until each condition holds (a vehicle of a kind near a point, moving if asked). */
  vehicleSeek(conds: Array<{ kind: 'tram' | 'rail' | 'pod' | 'ferry'; near: number[]; radius: number; moving?: number }>, horizon?: number): boolean;
  /** A vehicle by id, as it stands now. */
  vehicle(id: string): VehicleProbe | null;
  /** Every vehicle of a kind, as each stands now. */
  vehicleKinds(kind: 'tram' | 'rail' | 'pod' | 'ferry' | 'cab'): VehicleProbe[];
  /** A stand-in rider at a point facing a heading, or none. */
  vehicleRider(at: number[] | null, heading?: number): void;
  /** The personas (people.ts): how many figures, and what of them draws from this camera (null before the network is laid). */
  people(): PeopleView | null;
  /** An agent's figure as it stands now, or null. */
  person(agentId: string): FigureView | null;
  /** Every figure as it stands now. */
  persons(): FigureView[];
  /** Sends an agent's figure on a synthetic trip from one point to another, routed over the network (captures and the UI test). */
  peopleTrip(agentId: string, from: number[], to: number[]): string | null;
  /** Holds or releases the people's and the vehicles' clocks together, or moves both on (captures and tests). */
  peopleHold(on: boolean): void;
  peopleSkip(seconds: number): void;
  /** Holds the lanterns lit or dark for a capture, or follows the hour again with null. */
  peopleLantern(on: boolean | null): void;
  /** Follows an agent's figure as the agent page's Follow button and the F key do; null lets go. */
  follow(agentId: string | null): void;
  following(): string | null;
  /** The ambient traffic and crowd: how many, and what of them draws from this camera (null before the network is laid). */
  ambient(): AmbientView | null;
  /** Holds the ambient density at n (0 to 1), or follows the hour again with null. */
  ambientDensity(n: number | null): number | null;
  /** Holds or releases the ambient clock, or moves it on (captures and tests). */
  ambientHold(on: boolean): void;
  ambientSkip(seconds: number): void;
  /** Junctions near a point with cars standing at their lines, the most first: where, and how many (captures). */
  ambientQueues(near: number[], radius: number): Array<{ x: number; z: number; held: number }>;
  /** The quality the city draws at now (medium after an automatic drop). */
  quality(): 'high' | 'medium';
  /** Steps down to medium as the automatic drop does (tests). */
  dropQuality(): void;
  /** The notice line's text, or '' when none shows. */
  notice(): string;
  /** Puts a line in the running head, as the city does for what it did by itself (the UI test). */
  say(text: string): void;
  /** Plazas paved (the civic plaza included) and ambient buildings standing. */
  plots(): { plazas: number; buildings: number };
  /**
   * For captures that check a material against the datum and the Claude
   * amber: rebuilds a repo's tower with the named variants (ids from
   * variants.ts) and, if given, its datum after that many floors. Never
   * written anywhere; a reload restores the real look.
   */
  restyle(repo: string, ids: string[], datumIndex?: number): void;
  /**
   * For the `swatches` capture shot: floats one short tower per variant at
   * the overview's distance and bearing, moves the camera onto them, and
   * returns where each one's sunlit and shaded face sit on screen.
   */
  swatchBoard(): Promise<SwatchPoint[]>;
  /**
   * Stands agent towers at the spots given, each in its firm's look, the
   * ground under them cleared like a plot (captures and the UI test, for
   * towers grown past their real heights; reload to clear).
   */
  agentBoard(towers: TowerSpec[], spots: Array<{ x: number; z: number }>): Promise<void>;
  /** Stands the ambient tone board in the city's light and returns where to read each tone (captures only; reload to clear). */
  ambientBoard(): Promise<AmbientSwatchPoint[]>;
  /** Firms' quarters standing in the city. */
  quarters: number;
  /** The page the last agent or firm pick opened (its hash), until those pages exist (Task 38). */
  opened: string;
  /** Where an agent's tower stands: its centre and height, or null. */
  agentFrame(agentId: string): { center: number[]; width: number; height: number } | null;
  /**
   * For captures only: shows a firm's quarter as it stands between its
   * bankruptcy and the sale of its towers, every tower of its own dark.
   * Never written anywhere; `on` false (or the firm's real sale) clears it,
   * and a reload restores the real state.
   */
  darkQuarter(firmId: string, on?: boolean): void;
  /**
   * A firm's quarter as the city shows it now (Task 28): its plate, its
   * court's lamps, and each tower's light, scaffold, phase, root and firm.
   */
  quarterShow(firmId: string): { plate: string; court: number; settled: boolean; towers: Array<{ agentId: string; lit: number; scaffold: number; phase: string; root: string; firmId: string }> } | null;
  /** The exchange's tote board as it shows now, and whether its fountain runs. */
  exchange(): { slots: BoardSlot[]; running: boolean } | null;
  /** The job site on a repo's tower as the city shows it (crane, frame, arc), or null. */
  site(repo: string): ReturnType<ReturnType<typeof createCity>['site']>;
  /** Every job site the page knows, as the engine last sent it. */
  liveSites(): SiteState[];
  /** Rides up a tower (a repo, or `agent:<id>`) as Ride up and R do; null steps off as Escape does. False when it cannot. */
  ride(key: string | null): boolean;
  /** The ride under way, or null. */
  riding(): RideState | null;
  /** Holds the ride's clock, or sets it (captures). */
  rideHold(on: boolean): void;
  rideSeek(t: number): void;
  /** Hides or shows the sites' drawing, to measure what they cost (tests). */
  showSites(on: boolean): void;
}

declare global {
  interface Window {
    __palimpsest?: DebugHandle;
  }
}

/** Events that change what stands in the city: a new tower, a failed one, a restyle, a district leaving, or a floor laid, lit, scarred or taken down by the market. */
const REFRESH_ON = new Set([
  'repo.connected',
  'repo.analyzed',
  'repo.error',
  'repo.patched',
  'repo.disconnected',
  'floor.laid',
  'floor.lit',
  'floor.scarred',
  'floor.removed',
  'merge.reverted',
  'firm.bankrupt',
  'tower.sold',
  'agent.hired',
  'agent.retired',
]);
/**
 * Events that change the names on the market's floors (who works where, and which runs have reports) and
 * the firms' plates (how many agents, how many credits).
 */
const NAMES_ON = new Set(['agent.hired', 'agent.retired', 'firm.bankrupt', 'tower.sold', 'inspection.done', 'run.ended', 'merge.detected', 'floor.lit', 'report.written']);
/** Events after which the job sites are read afresh: a run starting or ending, or a floor laid, lit or taken down under one. */
const LIVE_ON = new Set(['run.started', 'run.ended', 'floor.laid', 'floor.lit', 'floor.removed', 'floor.scarred', 'merge.detected', 'trip.started', 'trip.ended']);
/** Events that change what the exchange's tote board shows: a job posted or moved on, a bid placed or declined. */
const BOARD_ON = new Set(['job.posted', 'job.proposed', 'job.changed', 'job.awarded', 'bid.placed', 'bid.satOut']);

/** How long a notice stands in the running head before it fades. */
const NOTICE_MS = 6000;
/** How many notices the recall mark keeps. */
const NOTICES_KEPT = 3;

/**
 * A one-line notice in the running head for what the city did by itself
 * (stood on plain stand-ins when the kits would not load, stepped down to
 * medium quality). It stands a few seconds and fades; a small mark stays at
 * the head's end to recall it: the last three, joined, so none is lost.
 */
function createNotice(head: HTMLElement): { add(text: string): void; text(): string } {
  const box = document.createElement('div');
  box.className = 'city-notice';
  box.hidden = true;
  const line = document.createElement('p');
  line.setAttribute('role', 'status');
  const recall = document.createElement('button');
  recall.type = 'button';
  recall.className = 'city-notice-recall';
  recall.textContent = 'Notice';
  recall.title = 'Show the last notice again';
  box.append(line, recall);
  head.append(box);
  /** The last few notices, oldest first; the recall shows them all. */
  const kept: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Sets the line's text so a screen reader announces it again, even when the words are the same. */
  const announce = (text: string): void => {
    line.textContent = '';
    line.title = text;
    requestAnimationFrame(() => {
      line.textContent = text;
    });
  };
  const fade = (): void => {
    timer = null;
    delete box.dataset.shown;
    recall.setAttribute('aria-expanded', 'false');
  };
  const show = (): void => {
    box.dataset.shown = '';
    recall.setAttribute('aria-expanded', 'true');
    if (timer) clearTimeout(timer);
    timer = setTimeout(fade, NOTICE_MS);
  };
  recall.addEventListener('click', () => {
    if (box.dataset.shown !== undefined) return fade();
    announce(kept.join(' '));
    show();
  });
  return {
    add(text) {
      kept.push(text);
      if (kept.length > NOTICES_KEPT) kept.splice(0, kept.length - NOTICES_KEPT);
      announce(text);
      box.hidden = false;
      show();
    },
    text: () => (box.hidden || box.dataset.shown === undefined ? '' : (line.textContent ?? '')),
  };
}

/** What the plate under an analyzing site says for each step of the engine's analysis. */
const STEP_TEXT: Record<string, string> = {
  mirror: 'Cloning history',
  log: 'Reading history',
  prs: 'Reading pull requests',
  floors: 'Laying out floors',
};

const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? '' : 's'}`;

/** What a firm's plate and plinth show of it, for telling when they change. */
const plateOf = (f: FirmView): string => `${f.id}|${f.name}|${Math.round(f.balance)}|${f.status}|${f.agents.filter((a) => !a.retired).length}`;

async function main(): Promise<void> {
  const host = document.getElementById('city');
  const veil = document.getElementById('veil');
  if (!host) throw new Error('missing #city');

  // The running head stands first, so the notices the city makes while it loads have their line in it.
  const runhead = createRunhead(document.body);
  const notice = createNotice(runhead.el);
  // The Blender-authored kits (masonry courses, crowns, roof pieces) load before anything is built from them.
  // Missing or corrupt, the city stands on plain stand-ins and says so, rather than going blank.
  /** Each firm's slot, which picks the colour of its mark on the floors it earned. */
  const firmSlots = new Map<string, number>();
  let firmsKey = '';
  const takeFirms = (firms: Array<{ id: string; slot: number }>): boolean => {
    for (const f of firms) firmSlots.set(f.id, f.slot);
    const key = [...firmSlots].sort().map(([id, slot]) => `${id}:${slot}`).join(',');
    const changed = key !== firmsKey;
    firmsKey = key;
    return changed;
  };
  const [settingsQuality] = await Promise.all([
    api.settings().then(
      (s) => s.quality,
      () => 'high' as const,
    ),
    api.firms().then(takeFirms, () => false),
    loadKits().catch((err: unknown) => {
      console.warn('the architecture kits did not load; building from plain stand-ins', err);
      registerFallbackKits();
      notice.add('The architecture kits did not load (kits/kits.glb is missing or damaged), so the city is built from plain blocks. Reinstalling Palimpsest restores them.');
    }),
  ]);
  /** The quality towers are built at: Settings' choice, until the city steps down by itself. */
  let quality: 'high' | 'medium' = settingsQuality;
  // Captures and the UI test hold the quality still with ?fixed-quality, so a slow headless frame never changes a shot.
  const autoQuality = !new URLSearchParams(location.search).has('fixed-quality');
  /**
   * Each tower's materials, picked over every repo that holds a slot,
   * connected or not, so neighbouring towers differ and a tower keeps its
   * look while a neighbour is switched off. Filled in by place().
   */
  let looks = new Map<string, Look>();
  /** Debug restyles (captures only): a look and a datum height per repo. */
  const restyled = new Map<string, { look: Look; datumIndex?: number }>();
  const lookOf = (d: District): Look => restyled.get(d.repo)?.look ?? looks.get(d.repo) ?? lookFor(d.repo);
  const city = createCity(host, {
    quality,
    autoQuality,
    makeDistrictCenterpiece: (d) => towerCenterpiece(d, quality, lookOf(d), { firmSlots }),
    centerpieceKey: (d) => `${lookKey(lookOf(d))}|${quality}|${d.tower.floors.some((f) => f.earned) ? firmsKey : ''}`,
    districtTones: (d) => towerTones(lookOf(d)),
    makeQuarterCenterpiece: (q) => {
      const looks = quarterLooks(q);
      return quarterCenterpiece(q, quality, (t) => looks.get(t.id) ?? lookFor(t.firmId ?? q.firmId), {
        name: firmViews.get(q.firmId)?.name ?? q.firmId,
        firmSlots,
        materials: towerMaterials,
      });
    },
    quarterKey: (q) => `${firmViews.get(q.firmId)?.name ?? ''}|${quality}|${firmsKey}`,
    // The civic exchange in the city's own pale limestone and granite.
    makeExchange: (q) => makeExchange(q, { materials: towerMaterials(lookFor('civic:exchange')) }),
    describeTrip: (trip, agent) => describeTrip(trip, agent),
    // A persona's coat: its firm's mark colour, as wool rather than painted metal.
    coatOf: (agent) => {
      const c = firmMarkColor(agent.firmId, firmSlots);
      return [c.r * 0.42, c.g * 0.42, c.b * 0.42];
    },
  });

  const debug: DebugHandle = {
    ready: false,
    quarters: 0,
    opened: '',
    agentFrame: (id) => {
      const f = city.agentFrame(id);
      return f ? { center: f.center.toArray(), width: f.width, height: f.height } : null;
    },
    site: (repo) => city.site(repo),
    liveSites: () => [...liveSites.values()],
    ride: (key) => {
      if (key === null) {
        ride?.stop();
        return true;
      }
      return rideUp(key);
    },
    riding: () => ride?.state() ?? null,
    rideHold: (on) => ride?.hold(on),
    rideSeek: (t) => ride?.seek(t),
    showSites: (on) => city.showSites(on),
    exchange() {
      const ex = city.exchange();
      return ex ? { slots: ex.slots(), running: ex.fountainRunning() } : null;
    },
    darkQuarter(firmId, on = true) {
      if (!on) {
        darkened.delete(firmId);
        place();
        return;
      }
      // As a live bankruptcy shows: the windows going out over two seconds.
      darkened.add(firmId);
      city.quarterEvent({ kind: 'bankrupt', firmId });
      place();
    },
    quarterShow(firmId) {
      const q = city.quarterShows().get(firmId);
      if (!q) return null;
      return {
        plate: q.plate,
        court: q.court,
        settled: q.settled,
        towers: q.towers.map((t) => ({ agentId: t.spec.agentId ?? '', lit: t.lit, scaffold: t.scaffold, phase: t.phase, root: t.spec.root, firmId: t.spec.firmId ?? firmId })),
      };
    },
    districts: 0,
    sites: 0,
    builds: 0,
    lastPick: null,
    inspect: (repo) => inspect(repo, null),
    openAgent: (agentId) => openAgent(agentId),
    highlight: null,
    view: (e, t) => city.view(new THREE.Vector3(e[0], e[1], e[2]), new THREE.Vector3(t[0], t[1], t[2])),
    camera: () => city.camera.position.toArray(),
    home: () => city.home(),
    limits: () => city.limits(),
    project: (p) => new THREE.Vector3(p[0], p[1], p[2]).project(city.camera).toArray(),
    precompile: () => city.precompile(),
    stats: () => city.stats(),
    breakdown: (detail) => city.breakdown(detail),
    river: () => city.river(),
    transit: () => city.transit(),
    vehicles: () => city.vehicles()?.view(city.camera) ?? null,
    ambient: () => city.ambient()?.view(city.camera) ?? null,
    ambientDensity: (n) => city.ambientDensity(n),
    ambientHold: (on) => city.ambient()?.hold(on),
    ambientSkip: (s) => city.ambient()?.skip(s),
    ambientQueues(near, radius) {
      const held = new Map<string, number>();
      for (const c of city.ambient()?.cars() ?? []) {
        if (c.speed > 0.3 || c.junction) continue;
        const to = c.lane.split('>')[1];
        held.set(to, (held.get(to) ?? 0) + 1);
      }
      return [...held.entries()]
        .map(([k, n]) => {
          const [x, z] = k.split(',').map(Number);
          return { x, z, held: n };
        })
        .filter((j) => Math.hypot(j.x - near[0], j.z - near[1]) < radius)
        .sort((a, b) => b.held - a.held);
    },
    vehicleHold: (on) => city.vehicles()?.hold(on),
    vehicleSkip: (s) => city.vehicles()?.skip(s),
    vehicleStage(kind, near) {
      const r = city.vehicles()?.stage(kind, near ? { x: near[0], z: near[1] } : undefined);
      return r ? probe(r) : null;
    },
    vehicleTrip(from, to) {
      const v = city.vehicles();
      const net = city.transitNetwork();
      if (!v || !net) return [];
      const legs = route({ x: from[0], z: from[1] }, { x: to[0], z: to[1] }, net);
      const trip: Trip = { id: 'probe', agentId: 'probe', firmId: 'probe', reason: 'home', jobId: null, from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, legs, startedAt: new Date().toISOString(), ms: 0, endedAt: null };
      return legs.map((l, i) => {
        if (l.mode === 'walk') return { mode: l.mode, id: null, boardsIn: 0, alightsIn: 0 };
        if (l.mode === 'cab') {
          const cab = v.summonCab(trip, i);
          return { mode: l.mode, id: cab.id, boardsIn: cab.arrivesIn({ x: l.path[0][0], z: l.path[0][2] }), alightsIn: Infinity };
        }
        const ride = v.board(trip, i);
        return { mode: l.mode, id: ride?.id ?? null, boardsIn: ride?.boardsIn() ?? -1, alightsIn: ride?.alightsIn() ?? -1 };
      });
    },
    vehicleSeek: (conds, horizon) => city.vehicles()?.seek(conds.map((c) => ({ ...c, near: { x: c.near[0], z: c.near[1] } })), horizon) ?? false,
    vehicleKinds(kind: 'tram' | 'rail' | 'pod' | 'ferry' | 'cab') {
      return city.vehicles()?.vehicles(kind).map(probe) ?? [];
    },
    vehicle(id) {
      const v = city.vehicles();
      if (!v) return null;
      for (const k of ['tram', 'rail', 'pod', 'ferry', 'cab'] as const) {
        const r = v.vehicles(k).find((x) => x.id === id);
        if (r) return probe(r);
      }
      return null;
    },
    vehicleRider: (at, heading) => city.vehicles()?.rider(at ? [at[0], at[1], at[2]] : null, heading),
    people: () => city.people()?.view(city.camera) ?? null,
    person: (id) => city.people()?.figures().find((f) => f.agentId === id) ?? null,
    persons: () => city.people()?.figures() ?? [],
    peopleTrip(agentId, from, to) {
      const net = city.transitNetwork();
      const agent = agentsAll().find((a) => a.id === agentId);
      if (!net || !agent) return null;
      const legs = route({ x: from[0], z: from[1] }, { x: to[0], z: to[1] }, net);
      const trip: Trip = { id: `probe:${agentId}:${Date.now()}`, agentId, firmId: agent.firmId, reason: 'job', jobId: null, from: { x: from[0], z: from[1] }, to: { x: to[0], z: to[1] }, legs, startedAt: new Date().toISOString(), ms: legs.reduce((s, l) => s + l.ms, 0), endedAt: null };
      probeTrips.set(agentId, trip);
      showTrips();
      return trip.id;
    },
    peopleHold(on) {
      city.vehicles()?.hold(on);
      city.people()?.hold(on);
    },
    peopleSkip(s) {
      city.vehicles()?.skip(s);
      city.people()?.skip(s);
    },
    peopleLantern: (on) => city.people()?.lantern(on),
    follow: (id) => followAgent(id),
    following: () => city.following(),
    quality: () => city.quality(),
    dropQuality: () => city.dropQuality(),
    notice: () => notice.text(),
    say: (text) => notice.add(text),
    plots: () => city.plots(),
    async ambientBoard() {
      // A board is measured with the streets empty: no car or person passes in front of it. The board stands on
      // (the capture reads it after this returns), so the streets stay empty with it; if laying it fails, the
      // density the city had comes back.
      const was = city.ambientDensity(0);
      let ok = false;
      try {
        const board = ambientBoard(city.scene, city.camera, (lots) => city.ambientBoard(lots), (e, t) => city.view(e, t));
        await city.precompile();
        await texturesSettled();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const points = board.points(innerWidth, innerHeight);
        ok = true;
        return points;
      } finally {
        if (!ok) city.ambientDensity(was);
      }
    },
    async agentBoard(towers, spots) {
      const pieces = towers.map((t, i) => {
        const piece = towerCenterpiece({ repo: t.id, index: i, origin: spots[i], tower: t }, quality, lookFor(t.firmId ?? t.id), { firmSlots });
        piece.object.position.set(spots[i].x, 0, spots[i].z);
        return piece.object;
      });
      city.board(pieces, spots);
      await city.precompile();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    },
    async swatchBoard() {
      // As the ambient board: empty streets while the board stands, the density restored if laying it fails.
      const was = city.ambientDensity(0);
      let ok = false;
      try {
        const board = swatchBoard(city.scene, city.camera, (e, t) => city.view(e, t));
        await city.precompile();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const points = board.points(innerWidth, innerHeight);
        ok = true;
        return points;
      } finally {
        if (!ok) city.ambientDensity(was);
      }
    },
    restyle(repo, ids, datumIndex) {
      const look = { ...lookOf(byRepo(repo) ?? ({ repo } as District)) };
      for (const id of ids) {
        const v = Object.values(VARIANTS).flat().find((x) => x.id === id);
        if (v) look[v.era] = v;
      }
      restyled.set(repo, { look, datumIndex });
      place();
    },
  };
  // The debug handle (captures, the UI test, probes) is exposed only with ?debug: a production window has none.
  if (new URLSearchParams(location.search).has('debug')) window.__palimpsest = debug;

  /** The towers the engine last served. */
  let served: District[] = [];
  /** Each firm's quarter as the engine last served it. */
  let servedQuarters: Quarter[] = [];
  /** Each firm as last read: its name, books and agents, for its plate and the name on its plinth. */
  const firmViews = new Map<string, FirmView>();
  /** Quarters shown dark by a capture (debug only). */
  const darkened = new Set<string>();
  /** The districts standing now: served towers whose repos are still connected. */
  let districts: District[] = [];
  /**
   * Every repo the page knows, connected or not, as last stored, with the
   * analysis step it reached. `done` holds a finished first analysis's
   * scaffold up until the refresh that brings its tower.
   */
  const known = new Map<string, RepoState & { step: string; done?: boolean }>();
  const byRepo = (repo: string): District | undefined => districts.find((d) => d.repo === repo);
  /** The step a repo's analysis last reported. */
  const analyzingStep = (repo: string): string => known.get(repo)?.step ?? '';

  // ---------------------------------------------------------------- navigation and screens
  /** Screens listen to the one event stream while they are open. */
  const listeners = new Set<(e: EngineEvent) => void>();
  const listen = (fn: (e: EngineEvent) => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  const toCity = (): void => navigate('city');
  const repos = createRepos(document.body, { listen, onDismiss: toCity });
  /** The kill switch, shown in the running head and as still water in the exchange's fountain. */
  const setStopped = (s: boolean): void => {
    runhead.setStopped(s);
    city.setStopped(s);
  };
  const settings = createSettings(document.body, { listen, onDismiss: toCity, onStopped: setStopped });
  const jobBoard = createJobs(document.body, { listen, onDismiss: toCity });
  void api.health().then((h) => setStopped(h.stopped), () => {});

  // ---------------------------------------------------------------- the inspector
  const inspector = createInspector(document.body, {
    onSelect(repo, floorId) {
      city.highlightFloor(repo, floorId);
      debug.highlight = floorId ? { repo, floorId } : null;
    },
    onFly(repo, floorId) {
      const f = city.floorFrame(repo, floorId);
      if (f) city.flyTo(f.center, Math.max(90, f.width * 4.4));
    },
    onRide: (repo) => rideUp(repo),
    onClose() {
      city.highlightFloor('', null);
      debug.highlight = null;
      city.setInset(0);
    },
  });

  // ---------------------------------------------------------------- the ride up a tower (Task 35)
  /** The ride under way: the car on the facade and the camera beside it, until Escape, a drag or the roof. */
  let ride: Ride | null = null;
  /** The site stages a ride ends at the work for, as the plan reads them. */
  const atWork = (s: SiteState): boolean => s.stage === 'crane' || s.stage === 'framing' || s.stage === 'inspecting' || s.stage === 'curing';
  /**
   * Rides the lift up a tower: a repo's, or an agent's (`agent:<id>`). The
   * plan stops at the datum, the scars and Claude's floors, and ends over the
   * roof or at the live work; the city draws the car and holds the camera.
   */
  function rideUp(key: string): boolean {
    const agentId = key.startsWith('agent:') ? key.slice(6) : null;
    const spec = agentId ? servedQuarters.flatMap((q) => q.towers).find((t) => t.agentId === agentId && !t.dark) : byRepo(key)?.tower;
    if (!spec) {
      notice.add('That tower is not standing in the city just now.');
      return false;
    }
    ride?.stop();
    const sites = agentId ? [] : [...liveSites.values()].filter((s) => s.repo === key && atWork(s));
    const live = sites.sort((a, b) => b.progress - a.progress)[0] ?? null;
    const earnedCount = spec.floors.filter((f) => !f.founding).length;
    const crown = spec.kind === 'agent' && earnedCount > 0 ? crownFor(spec.silhouette ?? 'plain', earnedCount).height : 0;
    const name = agentId ? (names.agents.get(agentId) ?? agentId) : (key.split('/')[1] ?? key);
    const plan = ridePlan(layoutTower(spec), spec.floors, { live, names, name, root: `${ROOT_NAMES[spec.root]} root`, crown, agent: spec.kind === 'agent' });
    if (document.body.dataset.route !== 'city') navigate('city');
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const hoist = live && city.siteHoist(key) ? key : null;
    city.followAgent(null);
    const started = startRide(city, key, plan, {
      parent: document.body,
      still: matchMedia('(prefers-reduced-motion: reduce)').matches,
      hoist,
      onEnd() {
        if (ride === started) ride = null;
        delete document.body.dataset.riding;
        // The inspector's own floor is marked again, and its panel keeps the view beside it.
        if (inspector.repo) {
          city.highlightFloor(inspector.repo, debug.highlight?.floorId ?? null);
          city.setInset(inspector.width);
        }
        if (opener?.isConnected && opener.checkVisibility()) opener.focus({ preventScroll: true });
        else document.querySelector<HTMLElement>('#city canvas')?.focus({ preventScroll: true });
      },
    });
    if (!started) {
      notice.add('That tower’s lift is not running just now.');
      return false;
    }
    ride = started;
    document.body.dataset.riding = '';
    city.setInset(0);
    // The focus leaves the panel the ride hides, for the city: Escape steps off from there.
    if (opener && opener.closest('.inspector')) document.querySelector<HTMLElement>('#city canvas')?.focus({ preventScroll: true });
    return true;
  }

  // ---------------------------------------------------------------- the market's names
  /** Agent and firm names for the earned floors, and each scar's inspection report, read from the engine. */
  let names: MarketNames = { agents: new Map(), firms: new Map(), inspections: new Map() };
  const readNames = coalesced(async () => {
    try {
      const firms = await api.firms();
      // A firm's plate shows its agents and books, and its plinth its name: a change re-places the plates.
      const before = JSON.stringify([...firmViews.values()].map(plateOf));
      firmViews.clear();
      for (const f of firms) firmViews.set(f.id, f);
      const platesChanged = JSON.stringify([...firmViews.values()].map(plateOf)) !== before;
      // A firm founded or hired since the city opened: its marks take their colour from its slot.
      if (takeFirms(firms) || platesChanged) place();
      const agents = new Map<string, string>();
      for (const f of firms) for (const a of f.agents) agents.set(a.id, a.name);
      // A scar links to its inspection report: read the run once for each scar not yet known.
      const scars = served.flatMap((d) => d.tower.floors.filter((f) => f.earned?.state === 'scar').map((f) => f.earned!.runId));
      const inspections = new Map(names.inspections);
      await Promise.all(
        scars
          .filter((id) => !inspections.has(id))
          .map((id) =>
            api.run(id).then(
              (r) => {
                if (r.inspectionId) inspections.set(id, r.inspectionId);
              },
              () => {},
            ),
          ),
      );
      names = { agents, firms: new Map(firms.map((f) => [f.id, f.name])), inspections };
      inspector.setNames(names);
      showTrips();
    } catch {
      /* the rows show ids until the names can be read */
    }
  });

  function inspect(repo: string, floorId: string | null): void {
    const d = byRepo(repo);
    if (!d) return;
    inspector.open(d, floorId);
    city.setInset(inspector.width);
    // From afar, approach the tower so it stands whole beside the panel; up close, the view stays where it is.
    const t = city.towerFrame(repo);
    if (t && city.camera.position.distanceTo(t.center) > Math.max(420, t.height * 3.5)) {
      city.flyTo(t.center, Math.max(160, t.height * 2.3));
    }
  }

  // The panel's width follows the window, and so does the view's offset.
  addEventListener('resize', () => {
    if (inspector.repo) city.setInset(inspector.width);
  });

  /** An agent's tower or a firm's plinth opens its page (Task 38), and the camera comes to the tower. */
  function openAgent(agentId: string): void {
    selectedAgent = agentId;
    debug.opened = `#/agents/${encodeURIComponent(agentId)}`;
    location.hash = debug.opened;
    const t = city.agentFrame(agentId);
    if (t && city.camera.position.distanceTo(t.center) > Math.max(300, t.height * 3.5)) city.flyTo(t.center, Math.max(120, t.height * 2.4));
  }
  function openFirm(firmId: string): void {
    debug.opened = `#/firms/${encodeURIComponent(firmId)}`;
    location.hash = debug.opened;
  }
  /** The exchange opens the job board (Task 36 draws it; until then the address changes). */
  function openJobs(): void {
    debug.opened = JOBS_ROUTE;
    location.hash = JOBS_ROUTE;
  }

  city.onPick((hit) => {
    debug.lastPick = hit;
    if (hit.kind === 'tower') inspect(hit.repo, hit.floorId);
    else if (hit.kind === 'agent') openAgent(hit.agentId);
    else if (hit.kind === 'person') {
      // A figure's plate opens its page where the camera stands: no flight to the tower.
      selectedAgent = hit.agentId;
      debug.opened = `#/agents/${encodeURIComponent(hit.agentId)}`;
      location.hash = debug.opened;
    } else if (hit.kind === 'exchange') openJobs();
    else openFirm(hit.firmId);
  });

  // ---------------------------------------------------------------- the exchange's tote board
  /** The open and bidding jobs, in the order they were posted, as the board last read them. */
  let posted: BoardJob[] = [];
  /**
   * Reads the board: every open and bidding job, oldest first, and the bids
   * each has drawn this round (the job's own detail, so only real bids count).
   * A card carries the repo's short name and the issue number, nothing more.
   */
  const readBoard = coalesced(async () => {
    try {
      const jobs = (await api.jobs()).filter((j) => j.status === 'open' || j.status === 'bidding').slice(0, 24);
      const bids = await Promise.all(jobs.map((j: Job) => (j.status === 'bidding' ? api.job(j.id).then((d) => d.bids.length, () => 0) : Promise.resolve(0))));
      posted = jobs.map((j, i) => ({ status: j.status, bids: bids[i], label: boardLabel(j) }));
      city.setBoard(posted);
      place();
    } catch {
      /* the board keeps what it last showed until the jobs can be read */
    }
  });

  // ---------------------------------------------------------------- job sites: live construction
  /**
   * Every job site, by run: read whole from /api/live on load and after a
   * reconnect or a run starting or ending, and moved one event at a time by
   * site.changed (a stage, or real progress). The city draws each repo's
   * busiest site; between events nothing on it advances.
   */
  const liveSites = new Map<string, SiteState>();
  const showSites = (): void => city.setSites([...liveSites.values()]);
  const readLive = coalesced(async () => {
    try {
      const view = await api.live();
      liveSites.clear();
      for (const s of view.sites) liveSites.set(s.runId, s);
      showSites();
      liveTrips = view.trips ?? [];
      showTrips();
    } catch {
      /* the sites keep what they last showed until the engine answers */
    }
  });

  // ---------------------------------------------------------------- the personas on their trips
  /**
   * The live trips (people.ts walks and rides them): read whole from
   * /api/live with the sites, after every trip.started and trip.ended, and
   * handed over with every agent the firms list, so a figure knows its
   * name and its firm's coat. A capture's synthetic trips (peopleTrip) ride
   * along with the real ones.
   */
  let liveTrips: Trip[] = [];
  const probeTrips = new Map<string, Trip>();
  const agentsAll = (): Agent[] => [...firmViews.values()].flatMap((f) => f.agents);
  const showTrips = (): void => {
    const trips = probeTrips.size ? [...liveTrips.filter((t) => !probeTrips.has(t.agentId)), ...probeTrips.values()] : liveTrips;
    city.setTrips(trips, agentsAll());
  };
  /** Job titles by id, read once each for the plates over the figures; a title arriving re-places the plates. */
  const jobTitles = new Map<string, string | null>();
  const titleOf = (jobId: string | null): string | null => {
    if (!jobId) return null;
    if (!jobTitles.has(jobId)) {
      jobTitles.set(jobId, null);
      api.job(jobId).then(
        (d) => {
          jobTitles.set(jobId, cleanText(d.job.title, 60));
          showTrips();
        },
        () => {},
      );
    }
    return jobTitles.get(jobId) ?? null;
  };
  /** Where a trip ends, in the city's words: a district's short name, the exchange, or a firm's quarter. */
  const placeOf = (p: { x: number; z: number }): string => {
    const d = districts.find((x) => Math.hypot(x.origin.x - p.x, x.origin.z - p.z) < 110);
    if (d) return d.repo.split('/')[1] ?? d.repo;
    if (Math.hypot(p.x, p.z - 40) < 90) return 'the exchange';
    const q = servedQuarters.find((x) => Math.hypot(x.origin.x - p.x, x.origin.z - p.z) < 110);
    if (q) return firmViews.get(q.firmId)?.name ?? 'its quarter';
    return 'the city';
  };
  function describeTrip(trip: Trip, agent: Agent): string {
    const title = titleOf(trip.jobId);
    const place = placeOf(trip.to);
    if (trip.reason === 'home') return `home to ${firmViews.get(agent.firmId)?.name ?? place}`;
    if (trip.reason === 'bid') return title ? `to the exchange to bid on ${title}` : 'to the exchange to bid';
    if (trip.reason === 'inspect') return title ? `to ${place} to inspect ${title}` : `to ${place} to inspect`;
    return title ? `to ${place} for ${title}` : `to ${place} to work`;
  }
  /** The agent the F key follows: the one whose page is open, or whose tower or figure was last picked. */
  let selectedAgent: string | null = null;
  function followAgent(agentId: string | null): void {
    if (agentId === null) {
      city.followAgent(null);
      return;
    }
    if (!city.people()?.positionOf(agentId)) {
      notice.add('That agent is not out in the city just now.');
      return;
    }
    navigate('city');
    city.followAgent(agentId);
  }

  // ---------------------------------------------------------------- districts, sites and plates
  /**
   * Places everything from the one occupied set: towers, scaffolds, the
   * plazas and the blocks round them, and the plates. A repo that is not
   * connected (off, disconnected, or a connect stopped before any tower)
   * gives its plot back to the ambient city; its slot stays its own.
   */
  function place(): void {
    const restyledServed = served.map((d) => {
      const at = restyled.get(d.repo)?.datumIndex;
      return at === undefined ? d : { ...d, tower: { ...d.tower, datumIndex: at } };
    });
    // A capture may show a quarter dark, as between a bankruptcy and the sale of its towers.
    const quarters = servedQuarters.map((q) =>
      darkened.has(q.firmId) ? { ...q, dark: true, towers: q.towers.map((t) => ({ ...t, dark: true, firmId: q.firmId, root: q.root })) } : q,
    );
    const occ = occupancy(known.values(), restyledServed, quarters);
    const sites = new Map<string, number>();
    for (const d of served) sites.set(d.repo, d.index);
    for (const r of known.values()) sites.set(r.fullName, r.slot);
    looks = pickLooks([...sites].map(([repo, slot]) => ({ repo, slot })));
    districts = occ.districts;
    debug.builds += city.setPlots(occ);
    debug.districts = occ.districts.length;
    debug.sites = occ.sites.length;
    debug.quarters = occ.quarters.length;

    const plates: Plate[] = occ.districts.map((d) => {
      const [owner, name] = d.repo.split('/');
      const n = d.tower.floors.length;
      return {
        key: d.repo,
        origin: d.origin,
        name: name ?? d.repo,
        sub: `${owner}, ${n === 0 ? 'root only' : plural(n, 'floor')}`,
        onActivate: () => inspect(d.repo, null),
      };
    });
    for (const s of occ.sites) {
      const [, name] = s.repo.split('/');
      plates.push({ key: s.repo, origin: s.origin, name: name ?? s.repo, sub: STEP_TEXT[analyzingStep(s.repo)] ?? 'Surveying the site' });
    }
    for (const q of occ.quarters) {
      const f = firmViews.get(q.firmId);
      // Its own agents at work: towers sold away are listed with their buyer, as bought, wherever they stand.
      const own = f ? f.agents.filter((a) => !a.retired).length : q.towers.filter((t) => (t.firmId ?? q.firmId) === q.firmId && !t.dark).length;
      const bought = occ.quarters.reduce((n, o) => n + (o.firmId === q.firmId ? 0 : o.towers.filter((t) => t.firmId === q.firmId).length), 0);
      const books = f ? `, ${Math.round(f.balance)} credits` : '';
      plates.push({
        key: `firm:${q.firmId}`,
        origin: q.origin,
        name: f?.name ?? q.firmId,
        sub: q.dark || f?.status === 'bankrupt' ? 'bankrupt' : `${plural(own, 'agent')}${bought ? `, ${bought} bought` : ''}${books}`,
        onActivate: () => openFirm(q.firmId),
      });
    }
    // The exchange's plate stands on its forecourt: what the board holds, in counts (never a job's own words).
    const taking = posted.filter((j) => j.status === 'bidding').length;
    plates.push({
      key: 'exchange',
      origin: { x: 0, z: 52 },
      name: 'The exchange',
      sub: posted.length === 0 ? 'No jobs posted' : `${plural(posted.length, 'job')} posted, ${taking} taking bids`,
      onActivate: openJobs,
    });
    city.setPlates(plates);

    const open = inspector.repo ? byRepo(inspector.repo) : undefined;
    if (inspector.repo && !open) inspector.close();
    else if (open) inspector.update(open);
  }

  const show = (next: District[], quarters: Quarter[] = servedQuarters): void => {
    served = next;
    servedQuarters = quarters;
    // A finished first analysis stops holding its scaffold once the refresh after it lands, tower or not.
    for (const r of known.values()) {
      if (r.done) {
        r.status = 'ready';
        r.done = false;
      }
    }
    place();
    // New scars may need their reports, and new floors their builders' names.
    readNames();
  };

  const countConnected = (): void => runhead.setConnected([...known.values()].filter((r) => r.connected).length);

  /** Takes a repo as stored now, keeping the step its analysis reached. */
  const takeRepo = (r: Repo, step?: string): void => {
    const was = known.get(r.fullName);
    known.set(r.fullName, {
      fullName: r.fullName,
      slot: r.slot,
      connected: r.connected,
      status: r.status,
      step: step ?? (r.status === 'analyzing' ? (was?.step ?? '') : ''),
    });
  };

  /** Takes the stored repos as they are now: which are connected, and which are analyzing. */
  const takeRepos = (list: Repo[]): void => {
    const steps = new Map([...known].map(([repo, k]) => [repo, k.step]));
    known.clear();
    for (const r of list) takeRepo(r, r.status === 'analyzing' ? steps.get(r.fullName) : undefined);
    countConnected();
  };

  try {
    const [loaded, repos, quarters] = await Promise.all([api.city(), api.repos().catch(() => [] as Repo[]), api.quarters().catch(() => [] as Quarter[])]);
    takeRepos(repos);
    show(loaded, quarters);
    readBoard();
    readLive();
  } catch (err) {
    console.warn('could not load the city from the engine', err);
    show([]);
  }

  // Events that land while a refresh is in flight are not dropped: one more refresh follows it.
  const refresh = coalesced(() =>
    Promise.all([api.city(), api.quarters().catch(() => servedQuarters)]).then(
      ([next, quarters]) => show(next, quarters),
      (err) => {
        console.warn('city refresh failed', err);
      },
    ),
  );
  api.events((e) => {
    if (e.type === 'engine.reconnected') {
      // Events sent while the stream was down are lost: read the repos, the city and the kill switch afresh.
      void api.repos().then((list) => {
        takeRepos(list);
        place();
      }, () => {});
      void api.health().then((h) => setStopped(h.stopped), () => {});
      refresh();
      readBoard();
      readLive();
      for (const fn of listeners) fn(e);
      return;
    }
    // Every repo event carries the repo as stored when it was sent, toggles included: a step reported by an
    // analysis that runs on after its repo was turned off says connected: false, and so raises nothing.
    const repo = (e.data as { repo?: Repo } | null)?.repo;
    if (repo?.fullName && typeof repo.connected === 'boolean') {
      const step = e.type === 'repo.analyzing' ? ((e.data as { step?: string }).step ?? '') : undefined;
      takeRepo(repo, step);
      const k = known.get(repo.fullName);
      // The scaffold stays until the refresh below brings the tower, so the site is never briefly empty.
      if (k && e.type === 'repo.analyzed' && k.connected) {
        k.status = 'analyzing';
        k.done = true;
      }
      countConnected();
      place();
    }
    if (e.type === 'engine.stopped' || e.type === 'engine.resumed') setStopped(e.type === 'engine.stopped');
    if (BOARD_ON.has(e.type)) readBoard();
    if (e.type === 'site.changed') {
      const s = (e.data as { site?: SiteState } | null)?.site;
      if (s?.runId && s.repo) {
        liveSites.set(s.runId, s);
        showSites();
      }
    }
    // A bankruptcy puts the firm's lights out over two seconds; a sale starts its buyer's re-clad (Task 28).
    if (e.type === 'firm.bankrupt') {
      const firmId = (e.data as { firmId?: string } | null)?.firmId;
      if (firmId) city.quarterEvent({ kind: 'bankrupt', firmId });
    }
    if (e.type === 'tower.sold') {
      const sold = e.data as { agentId?: string; from?: string } | null;
      if (sold?.agentId) city.quarterEvent({ kind: 'sold', agentId: sold.agentId });
      // A capture's dark override never hides a real sale.
      if (sold?.from && darkened.delete(sold.from)) place();
    }
    if (LIVE_ON.has(e.type)) readLive();
    if (REFRESH_ON.has(e.type)) refresh();
    if (NAMES_ON.has(e.type)) readNames();
    for (const fn of listeners) fn(e);
  });

  // Stepped down to medium by itself: every tower rebuilds at medium, and the notice says why.
  city.onQualityDrop(() => {
    quality = 'medium';
    place();
    notice.add('The city stepped down to medium quality to hold its frame rate. Settings can set it back to high for the next time it opens.');
  });

  // Escape on a sheet returns to the city, unless a field used it first (clearing a search, undoing a cap).
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented && document.body.dataset.route !== 'city') {
      e.preventDefault();
      toCity();
    }
    // H (or Home) in the city glides back to the home framing, which grows with the city.
    const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
    if ((e.key === 'h' || e.key === 'H' || e.key === 'Home') && !e.metaKey && !e.ctrlKey && !e.altKey && !typing && !e.defaultPrevented && document.body.dataset.route === 'city') {
      e.preventDefault();
      city.home();
    }
    // R rides the lift up the tower open in the inspector, or the selected agent's (Task 35).
    if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && !e.altKey && !typing && !e.defaultPrevented && document.body.dataset.route === 'city' && !ride) {
      const key = inspector.repo ?? (selectedAgent ? `agent:${selectedAgent}` : null);
      if (key) {
        e.preventDefault();
        rideUp(key);
      }
    }
    // F follows the selected agent's figure (Task 34); Escape in the city lets go of it.
    if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey && !typing && !e.defaultPrevented && document.body.dataset.route === 'city' && selectedAgent) {
      e.preventDefault();
      followAgent(selectedAgent);
    }
    if (e.key === 'Escape' && !e.defaultPrevented && document.body.dataset.route === 'city' && city.following()) city.followAgent(null);
  });

  // A job, a run and an inspection report each have a page (Task 37). The job's floor flies the city to it.
  const jobPage = createJobPage(document.body, {
    listen,
    onDismiss: toCity,
    floorStands: (repo, floorId) => city.floorFrame(repo, floorId) !== null,
    flyToFloor(repo, floorId) {
      navigate('city');
      inspect(repo, floorId);
      const f = city.floorFrame(repo, floorId);
      if (f) city.flyTo(f.center, Math.max(90, f.width * 4.4));
    },
  });
  const runPage = createRunPage(document.body, { listen, onDismiss: toCity });
  const inspectionPage = createInspectionPage(document.body, { listen, onDismiss: toCity });

  // The firms, a firm's page and an agent's page (Task 38). A firm's quarter flies the city to it.
  /** Where a firm's quarter stands: round its standing towers, else its plot's centre. */
  function quarterFrame(firmId: string): { center: THREE.Vector3; size: number } | null {
    const q = servedQuarters.find((x) => x.firmId === firmId);
    if (!q) return null;
    const box = new THREE.Box3();
    for (const t of q.towers) {
      const f = t.agentId ? city.agentFrame(t.agentId) : null;
      if (f) box.expandByPoint(f.center.clone().setY(0)).expandByPoint(f.center.clone().setY(f.height));
    }
    if (box.isEmpty()) return { center: new THREE.Vector3(q.origin.x, 10, q.origin.z), size: 60 };
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    return { center: center.setY(Math.min(center.y, 40)), size: Math.max(size.x, size.z, size.y * 0.8) };
  }
  const firmsList = createFirms(document.body, { listen, onDismiss: toCity });
  const firmPage = createFirmPage(document.body, {
    listen,
    onDismiss: toCity,
    quarterStands: (firmId) => servedQuarters.some((q) => q.firmId === firmId),
    flyToQuarter(firmId) {
      navigate('city');
      const f = quarterFrame(firmId);
      // The same glide the inspector and a picked tower use.
      if (f) city.flyTo(f.center, Math.max(160, f.size * 2.6));
    },
  });
  const agentPage = createAgentPage(document.body, {
    listen,
    onDismiss: toCity,
    follow: (agentId) => followAgent(agentId),
    rideUp: (agentId) => rideUp(`agent:${agentId}`),
  });

  // The treasury: his plan's windows, what the city spends of them, and the daily report (Task 39).
  const treasuryPage = createTreasury(document.body, { listen, onDismiss: toCity });

  // A district's own page: its market switches, label, checks, network, halt, jobs and floors (Task 40).
  const districtPage = createDistrictPage(document.body, { listen, onDismiss: toCity });

  // Repos, Settings, the job board, the job, run and inspection pages, the firms and a firm's and an
  // agent's page and the treasury draw over the city, which keeps running beside them. A place with no
  // screen yet (a district) leaves the city showing.
  const SCREENS = new Set(['repos', 'repo', 'settings', 'jobs', 'job', 'run', 'inspection', 'firms', 'firm', 'agent', 'treasury']);
  let lastRoute = 'city';
  onRoute((to, place) => {
    const route = SCREENS.has(to) && (place.id !== null || !['job', 'run', 'inspection', 'firm', 'agent', 'repo'].includes(to)) ? to : 'city';
    document.body.dataset.route = route;
    runhead.setRoute(route === 'job' || route === 'run' || route === 'inspection' ? 'jobs' : route === 'firm' || route === 'agent' ? 'firms' : route === 'repo' ? 'repos' : route);
    if (route !== 'city') {
      inspector.close();
      // A sheet opened over the city ends a ride under way.
      ride?.stop();
    }
    if (route === 'repos') repos.show();
    else repos.hide();
    if (route === 'settings') settings.show();
    else settings.hide();
    if (route === 'jobs') jobBoard.show(null);
    else jobBoard.hide();
    if (route === 'job') jobPage.show(place.id!);
    else jobPage.hide();
    if (route === 'run') runPage.show(place.id!);
    else runPage.hide();
    if (route === 'inspection') inspectionPage.show(place.id!);
    else inspectionPage.hide();
    if (route === 'firms') firmsList.show();
    else firmsList.hide();
    if (route === 'firm') firmPage.show(place.id!);
    else firmPage.hide();
    if (route === 'agent') {
      agentPage.show(place.id!);
      selectedAgent = place.id!;
    } else agentPage.hide();
    if (route === 'treasury') treasuryPage.show();
    else treasuryPage.hide();
    if (route === 'repo') districtPage.show(place.id!);
    else districtPage.hide();
    // Back in the city, focus returns to it rather than to a sheet that has gone.
    if (route === 'city' && lastRoute !== 'city') document.querySelector<HTMLElement>('#city canvas')?.focus({ preventScroll: true });
    lastRoute = route;
  });

  await city.ready;
  debug.ready = true;
  veil?.classList.add('gone');
  setTimeout(() => veil?.remove(), 1400);
}

void main();
