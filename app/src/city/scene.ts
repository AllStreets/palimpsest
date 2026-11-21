import * as THREE from 'three';

import { QUARTER_COURT, QUARTER_OFFSETS } from '../../../shared/district-layout.js';
import { FLOOR_HEIGHT, layoutTower } from '../../../shared/tower-layout.js';
import type { District, Era, Milestone, Quarter, SiteStage, SiteState } from '../../../shared/types.js';
import { REMERGE_BUDGET_MS, batchPiecesSteps, cancelRemerges, flushRemerges, longestRemerge, pendingRemerges, rebuildTarget, remergeOwner, runRemerges, scheduleRemerge, type Batched } from './batch.js';
import { finish, stepper, type Steps } from './steps.js';
import { plainBatch } from './plain-batch.js';
import { schoolBatch, type SchoolBatch } from './school-towers.js';
import { frameBreakdown, type Breakdown } from './breakdown.js';
import { createCameraRig, type ScriptPose } from './camera.js';
import { CAMPUS_INSPECT, createCampus, type Campus, type CampusAnchors } from './campus/index.js';
import { campusLife, EMPTY_LIFE, type CampusLife, type CampusLifeView, type LifeState } from './campus/life.js';
import type { ObservatoryState, ObservatoryView } from './campus/observatory.js';
import { masonryMaterial } from './campus/masonry.js';
import { CAMPUS_HALF, campusPlaza, TERRACE } from './campus/site.js';
import type { CollarPlaza } from './collar.js';
import { HALL } from './campus/halls.js';
import type { RideFloor } from './ride.js';
import { searchLitTree } from './searchlight.js';
import { makeConstruction, makeConstructionField, WORK_LAMP, type Construction, type ConstructionField } from './construction.js';
import { campanileStands, type BoardJob, type Exchange } from './exchange.js';
import { createFrameHooks } from './frame-hooks.js';
import { createGrid, type LotSummary } from './grid.js';
import { createGround, makePlinth } from './ground.js';
import { createPlates, type Plate } from './labels.js';
import type { Lot } from './lots.js';
import { configureMaterials, firstTexturesIn, texturesSettled } from './materials.js';
import { plazasOf, type Occupancy, type SiteSpot } from './occupancy.js';
import { qualityGovernor, type DropReading } from './governor.js';
import { setFacadeRooms } from './facade.js';
import { lightsOutTree } from './lightsout.js';
import { AO_NEAR, detailHidden, LAYER, passLayers, setLayers, shadowBoxMoves } from './lod.js';
import { VIEW_PX } from './lod-shader.js';
import { quarterLife, type QuarterEvent } from './quarter-life.js';
import { quarterBuildKey, quarterTreeSpots, rebuildDebounce, type QuarterShow } from './quarters.js';
import { clearOfTransit, createTrees, type TreeSpot } from './trees.js';
import { createPost, EXPOSURE, FLICKER, focusModeFor, type FocusMode, type LensState } from './post.js';
import { createRiver } from './river.js';
import { createTransit, type TransitView } from './transit.js';
import { createVehicles, type Vehicles } from './vehicles.js';
import { createPeople, type People } from './people.js';
import type { Agent, Trip } from '../../../shared/types.js';
import { ambientDensity, createAmbient, type Ambient, type AmbientPlaza, type CabPose } from './ambient.js';
import { createSignalHeads } from './signal-heads.js';
import { extentBlocks, type Network } from '../../../shared/commute.js';
import { makeScaffold, type Scaffold } from './scaffold.js';
import { createMilestones, findTowerPiece, type MilestoneShow, type Milestones, type TowerPiece } from './milestones.js';
import type { TowerMaterials } from './tower/kit.js';
import { createSky, HORIZON_FOG, installSkyFog, SUN_DIRECTION } from './sky.js';
import { createContactShadows } from './contact-shadow.js';
import { ROOT_TOP_HALF } from './tower/roots.js';
import { cityExtent, clearAirFloor, easeHome, easeLimits, fogFrom, opensHome, viewLimits, type EasedHome, type EasedLimits, type ViewLimits } from './view.js';

/** What a click in the city landed on: a district's tower (a floor, or its root), an agent's tower in a quarter, or a firm's plinth. */
export type PickHit =
  | { kind: 'tower'; repo: string; floorId: string | null }
  | { kind: 'agent'; agentId: string; firmId: string; floorId: string | null }
  | { kind: 'firm'; firmId: string }
  | { kind: 'exchange'; route: string }
  /** The observatory's dome (campus/observatory.ts): the school screen at the master. */
  | { kind: 'observatory'; route: string }
  /** The library (campus/index.ts): the campus's inspector, with the live voyage, the nets and the graduates. */
  | { kind: 'campus' }
  /** A persona's plate (people.ts). */
  | { kind: 'person'; agentId: string };

/** What stands at a district's origin, and which of its parts can be clicked (mapped to a floor id, or null). */
export interface Centerpiece {
  object: THREE.Object3D;
  pickables: Map<THREE.Object3D, string | null>;
  /** In a quarter: each pickable part of an agent's tower, mapped to its agent (the rest picks as the firm). */
  agents?: Map<THREE.Object3D, string>;
  dispose?(): void;
}

/** The longest a rebuild's shadow redraw waits for the rest of the rebuild, in seconds (askShadow). */
export const SHADOW_COALESCE_S = 0.6;
/** A factory may build at once or in steps (steps.ts), so the city can build a tower between frames. */
export type CenterpieceFactory = (d: District) => Centerpiece | Steps<Centerpiece>;
export type QuarterFactory = (q: Quarter) => Centerpiece | Steps<Centerpiece>;
const isSteps = <T>(x: T | Steps<T>): x is Steps<T> => typeof (x as { next?: unknown }).next === 'function';
/** A piece built in steps, or at once, as steps (one step, nothing to wait for). */
function* stepsOf<T>(x: T | Steps<T>): Steps<T> {
  return isSteps(x) ? yield* x : x;
}


export interface CityOptions {
  quality: 'high' | 'medium';
  /** Step down to medium by itself when the frame rate or the triangle budget is missed (default true; captures turn it off). */
  autoQuality?: boolean;
  /** Builds what stands in each district. Defaults to a plain stone plinth; towers plug in here. */
  makeDistrictCenterpiece?: CenterpieceFactory;
  /** Anything beyond the district's own data that changes what the factory builds (a tower's materials); a change rebuilds it. */
  centerpieceKey?: (d: District) => string;
  /**
   * A district's tower colours as the scene renders them (CIE Lab of its
   * stone and brick floors) and the L* of its stone: the ambient blocks at
   * its plaza edge keep clear of them and a value step away.
   */
  districtTones?: (d: District) => { tones: Array<[number, number, number]>; value?: number };
  /** Builds a firm's quarter (quarters.ts); without it quarters stand empty courts. */
  makeQuarterCenterpiece?: QuarterFactory;
  /** Anything beyond the quarter's own data that changes what the factory builds (its name, its looks); a change rebuilds it. */
  quarterKey?: (q: Quarter) => string;
  /** Builds the civic exchange on the plaza at the origin (exchange.ts); without it the plaza stands empty. */
  /** The exchange at a quality, with or without its campanile (exchange.ts campanileStands). */
  makeExchange?: (quality: 'high' | 'medium', campanile: boolean) => Exchange;
  /** A persona's plate's second line for its trip (people.ts): "to <district> for <job title>". */
  describeTrip?: (trip: Trip, agent: Agent) => string;
  /** A persona's coat, linear RGB: its firm's colour. */
  coatOf?: (agent: Agent) => [number, number, number];
  /** The steel and bronze the skyline's mast and finial are built in (milestones.ts); without them no milestone shows. */
  milestoneMaterials?: TowerMaterials;
  /** The university's materials (Phase 4): the halls' windows draw in its `window`; without it no campus is built. */
  campusMaterials?: TowerMaterials;
  /** A firm's mark colour (eras.ts firmMarkColor with the city's slots): its ribbon's satin. */
  firmColour?: (firmId: string) => THREE.Color;
}

/** A district site whose first analysis is still running: no tower yet, a scaffold stands there. */
export type Site = SiteSpot;

/** Where a floor or a whole tower stands in the world, for framing the camera on it. */
export interface Frame {
  center: THREE.Vector3;
  width: number;
  height: number;
}

export interface City {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /**
   * Shows the occupied plots: a tower for each district (only districts that
   * changed are rebuilt), a scaffold at each site, each firm's quarter, and
   * the ambient city round exactly those plots. Every other plot is the
   * city's. Returns how many districts and quarters were built.
   */
  setPlots(occ: Occupancy): number;
  /** Sets the street-level name plates. */
  setPlates(plates: Plate[]): void;
  /** Marks one floor of a district's tower, or clears the mark with null. Survives the district being rebuilt. */
  highlightFloor(repo: string, floorId: string | null): void;
  floorFrame(repo: string, floorId: string): Frame | null;
  towerFrame(repo: string): Frame | null;
  /**
   * Runs `fn` every frame after the plates have placed themselves (the screens' pins and lock-ons, Task 8). The
   * returned function removes it; calling it twice is harmless. A hook that throws is logged once and removed.
   */
  onFrame(fn: () => void): () => void;
  /** How many frame hooks are subscribed (tests). */
  frameHooks(): number;
  /** The repos of the districts standing now, as last set by setPlots. */
  districts(): string[];
  /** Shows the open and bidding jobs on the exchange's tote board. */
  setBoard(jobs: ReadonlyArray<BoardJob>): void;
  /** The engine's kill switch: the exchange's fountain runs only while it is off. */
  setStopped(stopped: boolean): void;
  /** The civic exchange as built now, or null (tests and debugging). */
  exchange(): Exchange | null;
  /**
   * The market's job sites (GET /api/live, then site.changed): a crane, a
   * rising frame, netting and welding on the roof of each repo's tower while
   * a run works there. One site per repo shows: the busiest.
   */
  setSites(sites: ReadonlyArray<SiteState>): void;
  /** The job site standing on a repo's tower: its stage and progress, the frame shown, and where the arc strikes (tests and captures). */
  site(repo: string): SiteView | null;
  /** Hides or shows every site's drawing (tests: what the sites cost in draw calls). */
  showSites(on: boolean): void;
  /** A firm's bankruptcy or a tower's sale seen live: its lights go out, or its buyer's re-clad starts (Task 28). */
  quarterEvent(e: QuarterEvent): void;
  /** Each quarter as it shows now, by firm: its plate, its court's lamps, each tower's light and scaffold (tests and captures). */
  quarterShows(): Map<string, QuarterShow>;
  /** Where an agent's tower stands, root to roof, for framing the camera on it. */
  agentFrame(agentId: string): Frame | null;
  /** Keeps the view centred in the part of the window not covered by a panel this wide on the right. */
  setInset(px: number): void;
  /** Compiles every material for the current scene so later frames never stall on a shader compile. */
  precompile(): Promise<void>;
  flyTo(target: THREE.Vector3, distance: number): void;
  /** Glides back to the framing the city opened on, as it stands now. */
  home(): void;
  /** The view's limits now: the home framing, and how far, how hazy and how deep, as eased this frame (tests and debugging). */
  limits(): { home: { eye: number[]; target: number[] }; maxDistance: number; fogDensity: number; far: number; settled: boolean };
  /** Multiplies the haze by k (the clear-air still shoots at 0.4 of the home value, Decision 5); null restores the city's own (debug and captures). */
  haze(k: number | null): void;
  onPick(fn: (hit: PickHit) => void): void;
  dispose(): void;
  /** Resolves once the first texture sets (materials.ts FIRST_SETS) have loaded and the first frames are on screen. */
  ready: Promise<void>;
  /** Jumps the camera to an eye and target (tests and debugging). */
  view(eye: THREE.Vector3, target: THREE.Vector3): void;
  /** Draw calls and triangles in the last whole frame, every pass included. */
  stats(): { calls: number; triangles: number };
  /** The geometries and textures the renderer holds on the GPU now (renderer.info.memory): a disposed one leaves the count. */
  memory(): { geometries: number; textures: number };
  /** Rebuilds still under way or waiting (the re-merge queue and the quarters' debounce): 0 once the city stands as asked. */
  rebuilding(): number;
  /** Runs `fn` once the districts and quarters stand as last asked (at once if nothing is being rebuilt); the latest only. */
  whenBuilt(fn: () => void): void;
  /** The longest single rebuild step since last asked, and its key (the UI test's hitch hunt). */
  longestStep(): { key: string; ms: number };
  /** How many floors the tower drawn for a repo now has (its floors' picks), or -1 when none is drawn. */
  drawnFloors(repo: string): number;
  /** Starts (true) or ends (false) a per-frame trace of the loop's own work, returning what the last one recorded (debug). */
  trace(on: boolean): Array<{ update: number; render: number; shadow: boolean; triangles: number }>;
  /** The next frame's draw calls and triangles by subsystem and pass, with the shadow map redrawn in it (debug and tests). */
  breakdown(detail?: boolean): Promise<Breakdown>;
  /**
   * An ID pass of one breakdown root (`campus`) against the city from where the camera stands (Phase 5 Task 10):
   * the share of its own projected area in the frame that the city in front of it leaves visible, 0 to 1.
   */
  visibleShare(key: string): Promise<number>;
  /**
   * How far from the eye each pixel's surface stands (Phase 5 Task 15a), at a small size of the frame's shape:
   * row-major from the top, in metres to DISTANCE_STEP, 0 where only sky stands (the haze's mid-distance band read).
   */
  distances(): Promise<{ width: number; height: number; metres: number[] }>;
  /** The river (river.ts): its lanterns, its static draw calls, and whether its water drew since last asked (tests). */
  river(): { lamps: number; meshes: number; triangles: number; drewWater: boolean; steps: number; colourScale: number };
  /** Plazas the ground paves (the civic plaza included) and ambient buildings standing (tests and debugging). */
  plots(): { plazas: number; buildings: number };
  /** The ambient lots standing within `r` of a point (grid.ts lots). */
  ambientLots(x: number, z: number, r: number): LotSummary[];
  /** The transit network (transit.ts): what of it the camera draws now, and how much of it stands (tests and captures). */
  transit(): TransitView;
  /** The trams, trains, pods, ferries and cabs running on the network (vehicles.ts), or null before it is laid. */
  vehicles(): Vehicles | null;
  /** The signal heads at the junctions (signal-heads.ts): how many stand and how many draw near the eye. */
  signalHeads(): { heads: number; drawn: number };
  /** The network as laid now (shared/commute.ts), or null before the city has districts. */
  transitNetwork(): Network | null;
  /** The ambient traffic and crowd (ambient.ts), or null before the network is laid. */
  ambient(): Ambient | null;
  /** The agent personas as people (people.ts), or null before the network is laid. */
  people(): People | null;
  /** The live trips and the agents they belong to: a figure per agent on its way (GET /api/live, trip.started, trip.ended). */
  setTrips(trips: ReadonlyArray<Trip>, agents: ReadonlyArray<Agent>): void;
  /**
   * A tower's floors as the ride climbs them (ride.ts), in the world, root
   * first: `key` is a district's repo, or `agent:<id>` for an agent's tower.
   * Null when no such tower stands.
   */
  rideTower(key: string): RideFloor[] | null;
  /** The crew's hoist on the site at work on a repo's tower, in the world, or null when no crane stands there. */
  siteHoist(repo: string): { object: THREE.Object3D; height: number; setCar(y: number): void } | null;
  /** Hands the camera to a scripted path (the ride) until a drag, a scroll, unscript() or the path's end; see camera.ts. */
  script(path: (dt: number) => ScriptPose | null, onRelease?: (why: 'user' | 'end') => void, focus?: 'ride' | 'tour'): void;
  unscript(): void;
  /** The lens as it stands this frame (post.ts): its close mode, how far on, the subject's distance, the background's blur. */
  lens(): LensState & { focus: number };
  /** Holds the lens in a close mode for a still staged without one (tools/perf.ts); undefined gives the camera's own mode back. */
  lensAs(mode: FocusMode | null | undefined): void;
  /** Something that casts a shadow moved (the ride's car): the cached shadow map is drawn again. */
  redrawShadows(): void;
  /** Glides to an eye and a target. */
  flyView(eye: THREE.Vector3, target: THREE.Vector3): void;
  /** Tints and fades the floor mark (the ride's bronze, with its caption), or null for the inspector's own. */
  highlightLook(look: { color: THREE.Color; alpha: number } | null): void;
  /** What the view looks at now (the orbit's centre). */
  viewTarget(): THREE.Vector3;
  /** Flies to and follows an agent's figure, 12 m behind and above, until a drag, Escape, the trip's end or null. */
  followAgent(agentId: string | null): void;
  following(): string | null;
  /** Holds the ambient density where a test or capture puts it (0 to 1), or null to follow the hour again; returns the hold it replaces. */
  ambientDensity(n: number | null): number | null;
  /**
   * Stands objects at spots in the city outside the plots, each spot paved
   * and cleared of ambient blocks like a district (captures and the UI test:
   * the agent silhouette board of grown towers).
   */
  board(objects: THREE.Object3D[], spots: Array<{ x: number; z: number }>): { dispose(): void };
  /** Draws ambient lots on their own, outside the city (the ambient swatch board). */
  ambientBoard(lots: Lot[]): { group: THREE.Group; dispose(): void };
  /** The quality the city draws at now: Settings' choice, or medium after the automatic drop. */
  quality(): 'high' | 'medium';
  /**
   * Steps down to medium now (the governor does this by itself when the
   * frame rate or the triangle budget is missed for several seconds): lighter
   * shadows, no ambient occlusion, pixel ratio 1. Listeners rebuild what they
   * built at high quality.
   */
  dropQuality(): void;
  /** Each listener hears what the city drew when it stepped down, and whether the camera stood at home then. */
  onQualityDrop(fn: (saw: QualityDrop) => void): void;
  /**
   * A tower as built, by its id: a district tower by `<repo>#founding`, an
   * agent tower by `agent:<id>`: its group, its layout, its roof's half width
   * and its true top. Null when no such tower stands.
   */
  towerPiece(towerId: string): TowerPiece | null;
  /** The engine's milestones (GET /api/milestones?active=1, then milestone.reached and milestone.changed): the spire and the finial stand on their towers. */
  setMilestones(ms: ReadonlyArray<Milestone>): void;
  /** Each milestone as it shows now, by id (tests and captures). */
  milestoneShows(): Map<string, MilestoneShow>;
  /** Hides or shows the ribbons (tests). */
  showRibbons(on: boolean): void;
  /** Hides or shows every tree (tests: the crowns read against the frame without them). */
  showTrees(on: boolean): void;
  /** The trees as planted (tests and captures): every spot, and how many draw at each level now. */
  trees(): { spots: TreeSpot[]; trees: number; near: number; far: number };
  /**
   * Stands the university on its plot (GET /api/school/campus, Phase 4
   * Task 34): the terrace, its quads and the four halls, with the ambient
   * city cleared off the block; null takes it down.
   */
  setCampus(origin: { x: number; z: number } | null): void;
  /** The campus as it stands: its origin and the anchors the later buildings take, or null before the engine took the plot. */
  campus(): { origin: { x: number; z: number }; anchors: CampusAnchors } | null;
  /** Holds the campus's clock at a moment (ms since the epoch) for a still or a test; null lets it follow his wall clock. */
  setCampusClock(ms: number | null): void;
  /** The school as the ledger tells it (Task 36): the observatory opens while the nets train, its plate lit while the master is trusted. */
  setSchool(s: ObservatoryState): void;
  /** The observatory as it shows now, or null before the campus stands (tests and captures). */
  observatory(): ObservatoryView | null;
  /** The campus's life as the ledger tells it (Task 37): the voyage sailing lights the library's bays; the nets and graduates for its inspector. */
  setLife(s: LifeState): void;
  /** The campus's life as it shows now (the bays' light, the live voyage, the students), or null before the campus stands. */
  campusLife(): CampusLifeView | null;
}

/** The frame rate and triangles the city drew when it stepped down, and whether that was the home view. */
export interface QualityDrop extends DropReading {
  fromHome: boolean;
}

/** A job site as the city shows it. */
export interface SiteView {
  stage: SiteStage;
  progress: number;
  runId: string;
  columns: number;
  beams: number;
  beamsTotal: number;
  /** World position of the crane's base and of the welding arc (null when nobody welds). */
  crane: number[];
  weld: number[] | null;
  /** How bright the arc burns this frame, 0 (between beads) to 1. */
  arc: number;
  /** The roof's plan centre, in the world. */
  centre: number[];
  /** The roof the site stands on and the new floor's height. */
  top: number;
  floorHeight: number;
  /** The inspection's searchlights: each lens and where its beam meets the floor, in the world. */
  searchlights: Array<{ at: number[]; end: number[] }>;
  /** The cure and the strike: how opaque the frame stands, how far the netting is down, the skeleton struck and the crane taken down. */
  frameFade: number;
  netDrop: number;
  strike: number;
  dismantle: number;
  /** What the floor finishes as and in which era, and how far its windows have lit. */
  floor: 'era' | 'primer' | null;
  era: Era | null;
  windows: number | null;
  /** The scar's work lamp, in the world, or null. */
  workLamp: number[] | null;
  /** True while a transition plays out. */
  busy: boolean;
  /** How many panes the merged floor's rows light, as last found on its tower. */
  panes: number;
}

/** Which of a repo's sites shows when it has more than one (a run waiting on its PR, and the next run at work). */
const SITE_RANK: Record<SiteStage, number> = { framing: 6, crane: 5, inspecting: 4, curing: 3, teardown: 2, scar: 1, waiting: 0 };

/** The plain plinth every district shows until towers exist. */
export function plinthCenterpiece(): Centerpiece {
  const object = makePlinth();
  const pickables = new Map<THREE.Object3D, string | null>();
  object.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) pickables.set(o, null);
  });
  return {
    object,
    pickables,
    dispose() {
      object.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    },
  };
}

const SHADOW_HALF = 320;
/** The distance pass's step in metres (one 8-bit level): it reads 0 to 2,550 m, the haze's mid band well inside. */
const DISTANCE_STEP = 10;
/** The sun's shadow camera stands this far up the sun's direction from the shadow's centre. */
const SUN_OFFSET = 800;
/** Below this eye height the skyline hides name plates behind it. */
const STREET_EYE = 80;

/**
 * The city at dusk: the sky dome and the environment lit from it, horizon
 * fog, a low warm sun with soft shadows that follow the view, the ground
 * and street grid, the ambient skyline, and one centerpiece per district.
 */
export function createCity(canvasHost: HTMLElement, opts: CityOptions): City {
  let quality = opts.quality;
  setFacadeRooms(quality === 'high');
  installSkyFog();
  const makeCenterpiece = opts.makeDistrictCenterpiece ?? (() => plinthCenterpiece());

  const width = (): number => Math.max(1, canvasHost.clientWidth);
  const height = (): number => Math.max(1, canvasHost.clientHeight);

  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  // 1.75 on retina keeps 60 fps at full window size on the M5 Pro; the difference from 2 is not visible through the post chain.
  renderer.setPixelRatio(Math.min(devicePixelRatio, quality === 'high' ? 1.75 : 1));
  renderer.setSize(width(), height());
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Counted per frame across the whole post chain, not per render call.
  renderer.info.autoReset = false;
  // Focusable by script only, so closing a panel can hand focus back to the city.
  renderer.domElement.tabIndex = -1;
  canvasHost.appendChild(renderer.domElement);
  configureMaterials(renderer);

  const scene = new THREE.Scene();
  const fog = new THREE.FogExp2(HORIZON_FOG.getHex());
  scene.fog = fog;

  const rig = createCameraRig(renderer.domElement, width() / height());
  const camera = rig.camera;
  // Each pass sees its own layers (lod.ts): the view, the sun's shadow map and the AO (post.ts) skip what the others own.
  const layers = passLayers();
  camera.layers.mask = layers.view.mask;

  const sky = createSky(renderer);
  scene.add(sky.dome);
  scene.environment = sky.environment;
  scene.environmentIntensity = 1.0;

  // Key light: the last of the sun, low and warm. Its shadow box follows the view, snapped to texels so edges do not crawl.
  const sun = new THREE.DirectionalLight(0xff9c5e, 2.4);
  sun.castShadow = true;
  let shadowSize = quality === 'high' ? 4096 : 2048;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  Object.assign(sun.shadow.camera, { left: -SHADOW_HALF, right: SHADOW_HALF, top: SHADOW_HALF, bottom: -SHADOW_HALF, near: 10, far: 1600 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.camera.layers.mask = layers.shadow.mask;
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0x8fa3c8, 0x2e241c, 0.35));
  // The welders' arcs light the steel round them from a fixed pool of point lights (post.ts FLICKER):
  // always in the scene, dark when unused, so an arc striking never recompiles the city's materials.
  const flickerLights = Array.from({ length: FLICKER.lights }, () => {
    const l = new THREE.PointLight(FLICKER.color, 0, FLICKER.distance, 2);
    l.castShadow = false;
    scene.add(l);
    return l;
  });
  const sunOffset = SUN_DIRECTION.clone().multiplyScalar(SUN_OFFSET);
  let texel = (SHADOW_HALF * 2) / shadowSize;

  const sunNeedsUpdate = (): void => {
    sun.shadow.needsUpdate = true;
  };
  const ground = createGround(quality);
  scene.add(ground.group);
  const grid = createGrid(quality, { sun: SUN_DIRECTION, half: SHADOW_HALF, offset: SUN_OFFSET, near: 10, far: 1600 });
  scene.add(grid.group);
  // The towers past the shadow map's box stand on their own baked contact shadows (Task 15, contact-shadow.ts).
  const contact = createContactShadows(SUN_DIRECTION, SHADOW_HALF);
  scene.add(contact.object);
  // The trees (trees.ts): the streets', the roof gardens', the quarters' garths' and the campus's, one draw per
  // species and level for all of them; planted again (once a frame at most) whenever any of those changes.
  const trees = createTrees(quality);
  scene.add(trees.object);
  let treesDirty = true;
  let treeSpots: TreeSpot[] = [];
  // The river, its quays, bridges and piers (river.ts); its water is drawn by a pass straight after the scene.
  const river = createRiver(quality);
  scene.add(river.group);

  let post = createPost(renderer, scene, camera, quality, [river.pass(camera)]);
  /** A close mode held for a staged still (lensAs), or undefined for the camera's own. */
  let lensOverride: FocusMode | null | undefined;
  // The tram, the elevated rail, the pods and the cab ranks (transit.ts), laid for the city as it stands.
  const transit = createTransit();
  scene.add(transit.group);
  // Its vehicles (vehicles.ts), timetabled on the network as laid; replaced when the network is laid again.
  const vehicleRoot = new THREE.Group();
  vehicleRoot.name = 'vehicles';
  scene.add(vehicleRoot);
  let vehicles: Vehicles | null = null;
  /** Whether the cabs have been given the traffic to queue behind. */
  let trafficSet = false;
  /** The network laid on this extent, and the vehicles, the traffic and the crowd laid again on it, a step at a time. */
  function* transitSteps(extent: { blocks: ReturnType<typeof extentBlocks>; districts: Array<{ x: number; z: number }> }, target: string): Steps<void> {
    try {
      yield* transitLay(extent);
    } finally {
      transitTarget.end(target);
    }
  }
  function* transitLay(extent: { blocks: ReturnType<typeof extentBlocks>; districts: Array<{ x: number; z: number }> }): Steps<void> {
    if (!(yield* transit.setSteps(extent))) return;
    askShadow();
    // The asphalt darkens with oil under the cab ranks' bays (transit.ts cabRank: three bays of 6.5 m).
    ground.setRanks((transit.network()?.ranks ?? []).map((r) => ({ x: r.x, z: r.z, dir: r.dir, length: 19.5 })));
    yield;
    const net = transit.network();
    if (vehicles && ambient && net) {
      yield* vehicles.relaySteps(net);
      yield;
      yield* ambient.relaySteps(net);
    } else layVehicles();
    treesDirty = true;
  }
  function layVehicles(): void {
    const net = transit.network();
    if (!net) return;
    // Laid again on the new network, keeping the clock: nothing jumps, and riders' refs resolve on.
    if (vehicles) vehicles.relay(net);
    else {
      vehicles = createVehicles(net, quality);
      vehicleRoot.add(vehicles.group);
    }
    // The unlabelled traffic and crowd on the streets inside the loop (ambient.ts).
    if (ambient) ambient.relay(net);
    else {
      ambient = createAmbient(net, quality, { plazas: ambientPlazas });
      ambient.setDensity(forcedDensity ?? hourDensity());
      ambientRoot.add(ambient.group);
    }
    // The personas (people.ts): they board the vehicles and are lit by the crowd's lamps.
    if (!people) {
      people = createPeople({
        vehicles: () => vehicles,
        net: () => transit.network(),
        lampLight: (x, y, z, out) => ambient?.lampLight(x, y, z, out),
        floorAt: (x, z) => ambient?.floorAt(x, z) ?? 0,
        // The lights the traffic keeps to: a persona on foot waits at the kerb for them.
        signals: () => ambient?.signals() ?? null,
        describe: opts.describeTrip,
        coatOf: opts.coatOf,
        onActivate: (agentId) => {
          for (const fn of pickListeners) fn({ kind: 'person', agentId });
        },
        onRelease: () => rig.unfollow(),
        // Trips to the university end at its gate, and trips from it start there (Task 37).
        campus: () => (campus && campusOrigin ? { origin: campusOrigin, half: CAMPUS_HALF, approach: campus.approach() } : null),
      });
      peopleRoot.add(people.group);
      people.set(pendingTrips.trips, pendingTrips.agents);
    }
  }
  // ---------------------------------------------------------------- the people
  const peopleRoot = new THREE.Group();
  peopleRoot.name = 'people';
  scene.add(peopleRoot);
  let people: People | null = null;
  /** The trips and agents as last set, for a people group made after they arrived. */
  const pendingTrips: { trips: ReadonlyArray<Trip>; agents: ReadonlyArray<Agent> } = { trips: [], agents: [] };
  let peoplePlatesVersion = -1;
  // ---------------------------------------------------------------- the ambient life
  // Unlabelled cars and people (ambient.ts). Their density follows the local hour, drifting out of sight.
  const ambientRoot = new THREE.Group();
  ambientRoot.name = 'traffic';
  scene.add(ambientRoot);
  // The signal heads at the junctions with lights (signal-heads.ts), counted with the traffic.
  const signalHeads = createSignalHeads();
  ambientRoot.add(signalHeads.group);
  let ambient: Ambient | null = null;
  let ambientPlazas: AmbientPlaza[] = [{ x: 0, z: 0, kind: 'civic' }];
  let forcedDensity: number | null = null;
  const tramAt: Array<{ x: number; z: number }> = [];
  const cabAt: CabPose[] = [];
  let densityClock = 0;
  const hourDensity = (): number => {
    const now = new Date();
    return ambientDensity(now.getHours() + now.getMinutes() / 60);
  };
  /** The streets' density at and below which the city counts as evening (the curve's level from eleven at night). */
  const EVENING_DENSITY = 0.5;
  /**
   * The city's own word on evening for the campus clock's dials: when the ambient density is held (a test or a
   * still saying what hour it is) the dials follow it, so they change with the streets; otherwise null, and the
   * tower reads sunset from the season and his clock.
   */
  const campusEvening = (): boolean | null => (campusClockAt !== null ? null : forcedDensity !== null ? forcedDensity <= EVENING_DENSITY : null);

  // ---------------------------------------------------------------- the civic exchange
  // Built once on the plaza at the origin, and again at medium if the city steps down; it keeps the board and the switch.
  let exchange: Exchange | null = null;
  let board: ReadonlyArray<BoardJob> = [];
  let stopped = false;
  /** Whether the campanile stands: only once a district rises 20 m over it (campanileStands), so it never tops a small new city. */
  let campanile = false;
  function buildExchange(): void {
    if (!opts.makeExchange) return;
    if (exchange) {
      scene.remove(exchange.object);
      exchange.dispose();
    }
    exchange = opts.makeExchange(quality, campanile);
    exchange.setBoard(board);
    exchange.setStopped(stopped);
    scene.add(exchange.object);
    sunNeedsUpdate();
    exchangeRev++;
    rebatchQuarters();
  }
  /** Bumped when the exchange is rebuilt: a quarters' batch merged from its old statics is merged again at its swap. */
  let exchangeRev = 0;

  // ---------------------------------------------------------------- districts
  const districtGroup = new THREE.Group();
  districtGroup.name = 'districts';
  scene.add(districtGroup);
  let centerpieces: Array<{ repo: string; key: string; piece: Centerpiece; d: District }> = [];
  let quarterPieces: Array<{ firmId: string; key: string; piece: Centerpiece; q: Quarter }> = [];
  /** Bumped whenever what stands in the districts changes, so the distance pass (districtLod) judges it afresh. */
  let lodRevision = 0;
  /** The district towers' plain meshes, one draw per material across every district (plain-batch.ts). */
  const towerPlains = plainBatch();
  districtGroup.add(towerPlains.group);
  /** Every pickable part in the city: towers' floors and roots, quarters' towers and plinths. */
  const allPickables = (): THREE.Object3D[] => [...[...centerpieces, ...quarterPieces].flatMap(({ piece }) => [...piece.pickables.keys()]), ...(exchange ? exchange.pickables.keys() : []), ...(campus ? campus.pickables.keys() : [])];
  let scaffolds = new Map<string, Scaffold>();
  let framed = false;

  // ---------------------------------------------------------------- milestones: the spire and the finial (milestones.ts)
  let milestoneRows: ReadonlyArray<Milestone> = [];
  let milestones: Milestones | null = opts.milestoneMaterials ? createMilestones({ quality, materials: opts.milestoneMaterials, firmColour: opts.firmColour }) : null;
  /** Firms seen going bankrupt live: their ribbons come down the frame their towers start to darken. */
  const fallen = new Set<string>();
  if (milestones) scene.add(milestones.group);
  function towerPiece(towerId: string): TowerPiece | null {
    return findTowerPiece(
      towerId,
      centerpieces.map(({ d, piece }) => ({ spec: d.tower, object: piece.object })),
      quarterPieces.map(({ q, piece }) => ({ quarter: q, object: piece.object })),
    );
  }
  /** Stands each milestone on its tower as built now: a tower rebuilt carries its ornament up, one removed takes it. */
  let milestoneTimer: ReturnType<typeof setTimeout> | null = null;
  function placeMilestones(): void {
    if (!milestones) return;
    const next = milestones.set(milestoneRows, towerPiece, Date.now(), { fallen });
    sun.shadow.needsUpdate = true;
    // The ornaments' draws may be new meshes: the distance pass judges their AO afresh.
    lodRevision++;
    // A milestone with an end (a revival's lights, a ribbon) goes dark at it, with no event to say so: placed again then.
    if (milestoneTimer) clearTimeout(milestoneTimer);
    milestoneTimer = next === null ? null : setTimeout(placeMilestones, Math.min(Math.max(0, next - Date.now()) + 50, 2 ** 31 - 1));
  }

  // ---------------------------------------------------------------- the university (campus/index.ts)
  const campusRoot = new THREE.Group();
  campusRoot.name = 'campus';
  scene.add(campusRoot);
  let campus: Campus | null = null;
  let campusOrigin: { x: number; z: number } | null = null;
  /** The campus's one opaque material, made once and kept across rebuilds. */
  let campusMasonry: THREE.Material | null = null;
  /** The campus clock held at a moment, or null for his wall clock. */
  let campusClockAt: number | null = null;
  /** The school's state as last told, kept across the campus's rebuilds. */
  let school: ObservatoryState = { training: false, masterTrusted: false, version: 0 };
  /** The campus's life (campus/life.ts), rebuilt with the campus; its state kept across rebuilds. */
  let campusLiving: CampusLife | null = null;
  let lifeState: LifeState = EMPTY_LIFE;
  /** Builds (or rebuilds at the quality now) and stands the campus where the engine put it. */
  function placeCampus(): void {
    if (campus) {
      campusLiving?.dispose();
      campusLiving = null;
      campusRoot.remove(campus.group);
      campus.dispose();
      campus = null;
    }
    if (!campusOrigin || !opts.campusMaterials) return;
    campusMasonry ??= masonryMaterial();
    campus = createCampus({ quality, materials: opts.campusMaterials, masonry: campusMasonry, now: () => (campusClockAt === null ? new Date() : new Date(campusClockAt)), evening: campusEvening });
    campus.set(campusOrigin);
    campus.setSchool(school);
    campusRoot.add(campus.group);
    campusLiving = campusLife(campus, { people: () => people, quality });
    campusLiving.setState(lifeState);
    treesDirty = true;
    sun.shadow.needsUpdate = true;
  }

  // ---------------------------------------------------------------- the view grows with the city
  // The limits follow the districts standing: the home framing changes at once (it is only used when asked
  // for), while how far the camera may go, the haze and the far plane ease over a second or two. The camera
  // itself is never moved for the city's sake once it has opened.
  let extent = cityExtent([]);
  let limits: ViewLimits = viewLimits(extent, width() / height());
  let eased: EasedLimits = { maxDistance: limits.maxDistance, fogDensity: limits.fogDensity, far: limits.far };
  /** The home the haze thins against (its distance and its target), eased with the rest so a growing city never makes it jump. */
  const easedHome: EasedHome = easeHome({ distance: 0, target: [0, 0, 0] }, { distance: limits.homeDistance, target: limits.home.target }, Infinity);
  /** A debug multiplier on the haze (the clear-air still, Decision 5): 1 is the city's own. */
  let hazeScale = 1;
  function relimit(snap: boolean): void {
    limits = viewLimits(extent, width() / height());
    if (snap) {
      eased = { maxDistance: limits.maxDistance, fogDensity: limits.fogDensity, far: limits.far };
      easeHome(easedHome, { distance: limits.homeDistance, target: limits.home.target }, Infinity, easedHome);
    }
  }
  const applyLimits = (): void => {
    rig.controls.maxDistance = eased.maxDistance;
    // Flown out past home the haze thins, so the whole city still reads from as far as the camera may go: measured
    // from the eased home, never from a home that just jumped (Task 6).
    // A haze thinned on purpose (haze(k), the clear-air still) never drops under the clear-air floor, so the ground's
    // far edge stays in haze; haze(0) alone means none (the tests' clear-air read).
    const own = fogFrom(eased.fogDensity, easedHome, camera.position);
    fog.density = hazeScale === 1 ? own : hazeScale > 0 ? Math.max(own * hazeScale, clearAirFloor(camera.position.distanceTo(rig.controls.target))) : 0;
    if (camera.far !== eased.far) {
      camera.far = eased.far;
      camera.updateProjectionMatrix();
    }
  };
  applyLimits();
  const toV = (v: number[]): THREE.Vector3 => new THREE.Vector3(v[0], v[1], v[2]);
  // Before anything of his stands, the camera waits on the empty city's home (view.ts EMPTY_EXTENT): over the
  // skyline, never down a street. The first placement with districts still opens on the city's own framing.
  rig.view(toV(limits.home.eye), toV(limits.home.target));

  /** Spots the board stands on, cleared like plots. */
  let boardSpots: Array<{ x: number; z: number }> = [];
  /** What else follows the camera each frame, after the plates (onFrame): nothing to do while none subscribes. */
  const frameHooks = createFrameHooks();
  let lastOcc: Occupancy = { districts: [], sites: [], quarters: [] };
  /** The occupied set last placed, floors and all (the job sites read the era of the floor a run laid from it). */
  let occNow: Occupancy = lastOcc;
  function updatePlazas(occ: Occupancy): void {
    lastOcc = occ;
    // Only occupied plots are paved and cleared: a district, or a site under scaffold (and the board's spots). The
    // campus's block is cleared like a quarter's court but never paved: its terrace is its own ground.
    const plazas: CollarPlaza[] = [...plazasOf(occ, opts.districtTones), ...boardSpots.map((b) => ({ x: b.x, z: b.z })), ...(campusOrigin ? [campusPlaza(campusOrigin)] : [])];
    // Once the city is showing, the ambient blocks are laid a row at a time over the next frames (Task 13) and the
    // rest follows when they are done; a freed plot's blocks then rise from the ground (grid.ts).
    if (spreading()) {
      scheduleRemerge(`${owner}plazas`, stepper(plazaSteps(plazas, occ), () => {}));
      return;
    }
    grid.setPlazas(plazas);
    finish(afterPlazas(plazas, occ));
  }
  function* plazaSteps(plazas: CollarPlaza[], occ: Occupancy): Steps<void> {
    yield* grid.setPlazasSteps(plazas);
    yield;
    yield* afterPlazas(plazas, occ);
  }
  function* afterPlazas(plazas: CollarPlaza[], occ: Occupancy): Steps<void> {
    // The terrace goes in too: the kerb tiles sink to the plane under it, though the ground is not paved there (street.ts).
    ground.setPlazas(plazas);
    yield;
    // The ambient traffic keeps off every plaza, court and site; the crowd walks the districts' and the civic plaza's.
    ambientPlazas = [
      { x: 0, z: 0, kind: 'civic' },
      ...occ.districts.map((d) => ({ x: d.origin.x, z: d.origin.z, kind: 'district' as const })),
      ...occ.sites.map((st) => ({ ...st.origin, kind: 'site' as const })),
      ...occ.quarters.map((q) => ({ x: q.origin.x, z: q.origin.z, kind: 'court' as const, court: QUARTER_COURT })),
      ...boardSpots.map((b) => ({ x: b.x, z: b.z, kind: 'site' as const })),
      ...(campusOrigin ? [{ x: campusOrigin.x, z: campusOrigin.z, kind: 'court' as const, court: campusPlaza(campusOrigin).court }] : []),
    ];
    if (ambient) yield* ambient.setPlazasSteps(ambientPlazas);
    yield;
    treesDirty = true;
    searchLitTree(grid.group);
    // Towers, scaffolds and the skyline around them may all have changed.
    askShadow();
  }

  /**
   * Whether a rebuild may be spread over frames (Task 13): once the city has
   * shown its first frames; before that it is built at once. A quality drop
   * spreads its rebuild too (Task 15).
   */
  const spreading = (): boolean => framesAfterLoad >= 3;
  /**
   * Waits, a frame at a time, while the programs of what a rebuild built are
   * compiled off the main thread (compileAsync, with the scene's lights): a
   * new look's material compiled at the swap cost a 116 ms frame (Task 13).
   */
  function* compiled(roots: THREE.Object3D[]): Steps<void> {
    // Built at once (before the city shows, or in a quality drop): there are no frames to wait in, so the first draw
    // compiles them, as before.
    if (!spreading()) return;
    let done = false;
    const all = roots.filter((r) => r.parent === null);
    if (all.length === 0) return;
    const holder = new THREE.Group();
    for (const r of all) holder.add(r);
    // Compiled as the frame draws them: into the composer's scene target (no tone mapping), as warmUp() does.
    const was = renderer.getRenderTarget();
    renderer.setRenderTarget(post.sceneTarget);
    renderer.compileAsync(holder, camera, scene).then(
      () => (done = true),
      () => (done = true),
    );
    renderer.setRenderTarget(was);
    for (const r of all) holder.remove(r);
    // At most two seconds of frames (and never forever, should the queue be flushed while it waits).
    for (let waits = 0; !done && waits < 120; waits++) yield;
  }
  /** When a rebuild first asked for the shadow map to be redrawn (seconds on the city's clock), or -1. */
  let shadowAsked = -1;
  function askShadow(): void {
    if (!spreading()) {
      sun.shadow.needsUpdate = true;
      return;
    }
    if (shadowAsked < 0) shadowAsked = clock.elapsedTime;
  }
  /** This city's own keys on the re-merge queue (batch.ts): cancelled on dispose, never another city's. */
  const owner = remergeOwner('city');
  /** What the districts, the quarters and the network are being rebuilt toward, while a rebuild is in flight. */
  const districtTarget = rebuildTarget();
  const quarterTarget = rebuildTarget();
  const transitTarget = rebuildTarget();
  /**
   * What waits for the city to stand as last asked (main.ts: the plates and
   * the inspector, so what he sees and clicks follows what is drawn, not
   * what is still being built). The latest only; run at once when nothing
   * is being rebuilt.
   */
  let builtWaiter: (() => void) | null = null;
  const structureBuilding = (): boolean => districtTarget.busy() || quarterTarget.busy() || quarterWait.waiting();
  function settle(): void {
    if (!builtWaiter || structureBuilding()) return;
    const fn = builtWaiter;
    builtWaiter = null;
    fn();
  }
  /** Bumped whenever a pending rebuild is overtaken, so a job that is no longer wanted never commits. */
  let districtJob = 0;
  function placeDistricts(districts: District[]): number {
    // A district whose data is unchanged keeps its built tower; only new or changed ones are built.
    const old = new Map(centerpieces.map((c) => [c.repo, c]));
    const wanted = districts.map((d) => {
      const key = JSON.stringify(d) + (opts.centerpieceKey?.(d) ?? '');
      const kept = old.get(d.repo);
      return kept && kept.key === key ? { d, key, kept } : { d, key, kept: null };
    });
    const built = wanted.filter((w) => !w.kept).length;
    const removed = centerpieces.filter((c) => !wanted.some((w) => w.kept === c)).length;
    if (built === 0 && removed === 0) {
      // Nothing to build: the districts' data (their floors' states) moves on in place.
      centerpieces = wanted.map((w) => ({ ...w.kept!, d: w.d }));
      districtJob++;
      cancelRemerges(`${owner}districts`);
      districtTarget.end(districtTarget.current() ?? '');
      return 0;
    }
    // The same change again while it is being built (refreshes come in bursts): the rebuild in flight goes on.
    const target = wanted.map((w) => w.key).join('\n');
    if (spreading() && districtTarget.same(target)) return built;
    const job = ++districtJob;
    districtTarget.start(target);
    const steps = districtSteps(wanted, job, target);
    if (spreading()) scheduleRemerge(`${owner}districts`, stepper(steps, () => {}));
    else finish(steps);
    return built;
  }
  /** Builds the changed towers and re-merges their plain meshes a step at a time, then swaps them all in at once. */
  function* districtSteps(wanted: Array<{ d: District; key: string; kept: (typeof centerpieces)[number] | null }>, job: number, target: string): Steps<void> {
    const made: Array<(typeof centerpieces)[number]> = [];
    const fresh: Centerpiece[] = [];
    for (const w of wanted) {
      if (w.kept) {
        made.push({ ...w.kept, d: w.d });
        continue;
      }
      const piece = yield* stepsOf(makeCenterpiece(w.d));
      fresh.push(piece);
      piece.object.position.set(w.d.origin.x, 0, w.d.origin.z);
      piece.object.userData.repo = w.d.repo;
      made.push({ repo: w.d.repo, key: w.key, piece, d: w.d });
    }
    districtGroup.updateMatrixWorld(true);
    for (const c of made) c.piece.object.updateMatrixWorld(true);
    const picks = new Set(made.flatMap(({ piece }) => [...piece.pickables.keys()]));
    yield* compiled(fresh.map((p) => p.object));
    const commit = yield* towerPlains.prepare(
      made.map(({ piece }) => piece.object),
      (o) => picks.has(o),
    );
    if (job !== districtJob) {
      // Overtaken: a later placement builds what is wanted now. What this one built never drew.
      for (const p of fresh) p.dispose?.();
      districtTarget.end(target);
      return;
    }
    const keep = new Set(made.map((c) => c.piece));
    for (const { piece } of centerpieces) {
      if (keep.has(piece)) continue;
      districtGroup.remove(piece.object);
      piece.dispose?.();
    }
    for (const p of fresh) districtGroup.add(p.object);
    centerpieces = made;
    commit();
    lodRevision++;
    if (highlighted) applyHighlight();
    // Its tower stands: a scaffold kept for it comes down in the same frame.
    placeSites(sitesStanding(occNow));
    afterSwap([...fresh.map((p) => p.object), towerPlains.group]);
    // What he sees and clicks follows in the same frame as the swap.
    districtTarget.end(target);
    settle();
    yield;
    afterSwapLater();
  }
  /** What follows any rebuild once it stands: the sites move onto new roofs, the searchlights and the dust find it, the shadow is redrawn. */
  /** In the frame of the swap: what draws the new pieces as the old drew (the searchlights' streak, a dark tower's dust). */
  function afterSwap(roots: THREE.Object3D[]): void {
    // Only what was swapped in: the materials of what already stood were given the searchlights' streak and the dust
    // when it was swapped in itself (walking the whole district group is a frame's worth of work on its own).
    for (const r of roots) {
      searchLitTree(r);
      lightsOutTree(r);
    }
    askShadow();
  }
  /** A frame later: the sites onto the new roofs, the skyline's milestones, the trees round the courts. */
  function afterSwapLater(): void {
    placeConstructions();
    placeMilestones();
    treesDirty = true;
    askShadow();
  }

  /**
   * Every quarter's towers, walks, plinth and court, and the exchange's
   * unchanging stone, copper and glass, drawn as one set of batches across
   * the city (batch.ts): the pieces themselves stay, hidden, for picking,
   * framing and the next rebuild. The exchange's board, water and clock hands
   * draw themselves.
   */
  let quarterBatch: Batched | null = null;
  function rebatchQuarters(): void {
    finish(rebatchSteps(quarterPieces.map(({ piece }) => piece.object)))();
  }
  /**
   * The quarters' batch over these roots and the exchange's statics, merged
   * a step at a time (batch.ts); nothing drawn changes until the returned
   * commit swaps it in. The roots stay hidden throughout: batchPieces merges
   * a hidden root as it would a shown one.
   */
  function* rebatchSteps(pieces: THREE.Object3D[]): Steps<() => void> {
    const roots = [...pieces, ...(exchange?.statics ?? [])];
    const rev = exchangeRev;
    districtGroup.updateMatrixWorld(true);
    exchange?.object.updateMatrixWorld(true);
    for (const r of roots) r.visible = false;
    const next = roots.length ? yield* batchPiecesSteps(roots) : null;
    return () => {
      if (quarterBatch) {
        districtGroup.remove(quarterBatch.group);
        quarterBatch.dispose();
      }
      quarterBatch = next;
      if (next) {
        next.group.name = 'quarters';
        districtGroup.add(next.group);
      }
      lodRevision++;
      // The exchange was rebuilt while this batch was merged from its old statics (the campanile came or went): merged
      // again now, at once, from the pieces just swapped in (rare: only when a district crosses the campanile's height).
      if (rev !== exchangeRev) finish(rebatchSteps(pieces))();
    };
  }

  /**
   * The school's towers (Task 38): every agent tower on the collegiate root,
   * taken out of its quarter's draw and drawn across the city in the
   * university's own masonry (school-towers.ts), under the `schoolTowers`
   * key: at most four calls from home however many graduates are hired.
   */
  const schoolRoot = new THREE.Group();
  schoolRoot.name = 'schoolTowers';
  scene.add(schoolRoot);
  let schoolTowers: SchoolBatch | null = null;
  function batchSchoolTowers(): void {
    const towers = quarterPieces.flatMap(({ piece }) => piece.object.children.filter((c) => c.userData.school === true));
    if (!schoolTowers) {
      if (towers.length === 0 || !opts.campusMaterials) return;
      campusMasonry ??= masonryMaterial();
      schoolTowers = schoolBatch(campusMasonry, opts.campusMaterials.window);
      schoolRoot.add(schoolTowers.group);
    }
    districtGroup.updateMatrixWorld(true);
    if (schoolTowers.set(towers)) sun.shadow.needsUpdate = true;
  }

  let quarterJob = 0;
  /** A quarter rebuild waiting out its debounce (quarters.ts rebuildDebounce). */
  const quarterWait = rebuildDebounce<Steps<void>>();
  /**
   * The quarters as wanted: a changed one is rebuilt (quarters.ts, a floor
   * at a time once the city is showing), the school's towers taken out of
   * it, and the quarters' batch re-merged, all swapped in at once. `debounce`
   * holds the start until no change has come for QUARTER_DEBOUNCE_S (hires
   * and sales come in bursts); a re-clad, behind its scaffold, starts at once.
   */
  function placeQuarters(quarters: Quarter[], debounce = false): number {
    const old = new Map(quarterPieces.map((c) => [c.firmId, c]));
    const wanted = quarters.map((q) => {
      // Built the same lit or dark (the lights are a uniform): only what the build depends on rebuilds it.
      const key = quarterBuildKey(q) + (opts.quarterKey?.(q) ?? '');
      const kept = old.get(q.firmId);
      return kept && kept.key === key ? { q, key, kept } : { q, key, kept: null };
    });
    const built = wanted.filter((w) => !w.kept).length;
    const removed = quarterPieces.filter((c) => !wanted.some((w) => w.kept === c)).length;
    treesDirty = true;
    if (built === 0 && removed === 0) {
      quarterPieces = wanted.map((w) => ({ ...w.kept!, q: w.q }));
      quarterJob++;
      quarterWait.clear();
      cancelRemerges(`${owner}quarters`);
      quarterTarget.end(quarterTarget.current() ?? '');
      return 0;
    }
    // The same change again, waiting or under way: left to finish (the debounce is not restarted for a repeat).
    const target = wanted.map((w) => w.key).join('\n');
    if (spreading() && quarterTarget.same(target)) return built;
    const job = ++quarterJob;
    quarterTarget.start(target);
    // A newer change: whatever was under way is let go before it does any more work.
    cancelRemerges(`${owner}quarters`);
    const steps = quarterSteps(wanted, job, target);
    if (!spreading()) {
      quarterWait.clear();
      finish(steps);
    } else if (debounce) quarterWait.touch(clock.elapsedTime, steps);
    else {
      quarterWait.clear();
      scheduleRemerge(`${owner}quarters`, stepper(steps, () => {}));
    }
    return built;
  }
  function* quarterSteps(wanted: Array<{ q: Quarter; key: string; kept: (typeof quarterPieces)[number] | null }>, job: number, target: string): Steps<void> {
    const made: Array<(typeof quarterPieces)[number]> = [];
    const fresh: Centerpiece[] = [];
    for (const w of wanted) {
      if (w.kept) {
        made.push({ ...w.kept, q: w.q });
        continue;
      }
      const piece = yield* stepsOf(opts.makeQuarterCenterpiece?.(w.q) ?? { object: new THREE.Group(), pickables: new Map() });
      piece.object.position.set(w.q.origin.x, 0, w.q.origin.z);
      piece.object.userData.firmId = w.q.firmId;
      piece.object.updateMatrixWorld(true);
      fresh.push(piece);
      made.push({ firmId: w.q.firmId, key: w.key, piece, q: w.q });
    }
    // The school's towers are drawn by their own batch (school-towers.ts), taken and merged off screen first: taking a
    // tower hides its parts, so the quarters' merge after leaves them out, and both batches swap in the same frame.
    const schoolTowersIn = made.flatMap(({ piece }) => piece.object.children.filter((c) => c.userData.school === true));
    if (!schoolTowers && schoolTowersIn.length && opts.campusMaterials) {
      campusMasonry ??= masonryMaterial();
      schoolTowers = schoolBatch(campusMasonry, opts.campusMaterials.window);
      schoolRoot.add(schoolTowers.group);
    }
    yield* compiled(fresh.map((p) => p.object));
    const schoolSwap = schoolTowers ? yield* schoolTowers.prepare(schoolTowersIn) : null;
    const swap = yield* rebatchSteps(made.map(({ piece }) => piece.object));
    if (job !== quarterJob) {
      for (const p of fresh) p.dispose?.();
      quarterTarget.end(target);
      return;
    }
    const keep = new Set(made.map((c) => c.piece));
    for (const { piece } of quarterPieces) {
      if (keep.has(piece)) continue;
      districtGroup.remove(piece.object);
      piece.dispose?.();
    }
    for (const p of fresh) districtGroup.add(p.object);
    quarterPieces = made;
    if (schoolSwap?.()) askShadow();
    swap();
    afterSwap([...fresh.map((p) => p.object), ...(quarterBatch ? [quarterBatch.group] : []), schoolRoot]);
    // What he sees and clicks follows in the same frame as the swap.
    quarterTarget.end(target);
    settle();
    yield;
    afterSwapLater();
  }

  /**
   * The quarters over time (Task 28): a bankrupt firm's lights going out, a
   * buyer's scaffold rising round the tower it bought, the floors rebuilt
   * behind it, the scaffold struck and the windows relit.
   */
  const life = quarterLife((agentId) => {
    // The agent's pick proxies: its root picks as null, each floor as its own id.
    for (const { piece } of quarterPieces) {
      const root = new THREE.Box3();
      const upper = new THREE.Box3();
      for (const [o, id] of piece.agents ?? []) {
        if (id !== agentId) continue;
        o.updateWorldMatrix(true, false);
        const b = new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)).applyMatrix4(o.matrixWorld);
        (piece.pickables.get(o) == null ? root : upper).union(b);
      }
      if (!root.isEmpty()) return { root, upper: upper.isEmpty() ? null : upper };
    }
    return null;
  });
  scene.add(life.group);
  /** Seconds since the scaffolds last asked for a shadow redraw: they move in steps, so the map follows in quarter seconds. */
  let lifeShadow = 0;
  function updateLife(dt: number): void {
    const { draw, moved } = life.update(dt);
    if (draw) {
      placeQuarters(draw);
      placeMilestones();
      searchLitTree(districtGroup);
      searchLitTree(schoolRoot);
      lightsOutTree(districtGroup);
      lightsOutTree(schoolRoot);
      sun.shadow.needsUpdate = true;
    }
    lifeShadow += dt;
    if (moved && lifeShadow > 0.25) {
      lifeShadow = 0;
      sun.shadow.needsUpdate = true;
    }
  }

  buildExchange();

  /** The view's limits follow everything that stands: districts, and each agent tower where it stands in its quarter. */
  function reframe(occ: Occupancy): void {
    const agents = occ.quarters.flatMap((q) =>
      q.towers.map((t, i) => {
        const at = QUARTER_OFFSETS[t.towerIndex ?? i] ?? { x: 0, z: 0 };
        return { origin: { x: q.origin.x + at.x, z: q.origin.z + at.z }, tower: t };
      }),
    );
    extent = cityExtent([...occ.districts, ...agents], campusOrigin ? [{ x: campusOrigin.x, z: campusOrigin.z, height: TERRACE + HALL.ridge + 4 }] : []);
    // The city opens on its home framing, with its limits in force at once, at the first placement that has
    // anything standing (an empty first answer leaves the camera unframed); after that the limits ease.
    const open = opensHome(framed, occ.districts.length + occ.quarters.length);
    relimit(open);
    if (open) {
      applyLimits();
      rig.view(toV(limits.home.eye), toV(limits.home.target));
      framed = true;
    }
  }

  /**
   * The scaffolds that stand: every site, and a scaffold whose repo's tower
   * is being built and not yet swapped in (a scaffold leaves only when its
   * tower lands).
   */
  function sitesStanding(occ: Occupancy): Site[] {
    const waiting = occ.districts.filter((d) => scaffolds.has(d.repo) && !pieceOf(d.repo) && !occ.sites.some((s) => s.repo === d.repo));
    return [...occ.sites, ...waiting.map((d) => ({ repo: d.repo, origin: d.origin }) as Site)];
  }
  function placeSites(sites: Site[]): void {
    const next = new Map<string, Scaffold>();
    for (const s of sites) {
      let sc = scaffolds.get(s.repo);
      if (sc) scaffolds.delete(s.repo);
      else {
        sc = makeScaffold();
        districtGroup.add(sc.object);
      }
      sc.object.position.set(s.origin.x, 0, s.origin.z);
      next.set(s.repo, sc);
    }
    for (const sc of scaffolds.values()) {
      districtGroup.remove(sc.object);
      sc.dispose();
    }
    scaffolds = next;
  }

  // ---------------------------------------------------------------- job sites: cranes, frames and welding
  let liveSites: SiteState[] = [];
  /**
   * The city's job sites, one per run: the busiest site of each repo, a site
   * the market no longer lists while its own transition (a cure, a strike)
   * plays out, and every scar's work lamp for the rest of the evening.
   */
  const constructions = new Map<string, { c: Construction; site: SiteState; top: number; floorHeight: number; panes?: number }>();
  // Every site is drawn by one field of batches: each site's own object is the record it copies, kept out of the scene.
  let field: ConstructionField = makeConstructionField(quality);
  scene.add(field.group);

  /** A run's own floor on its repo's tower: the floor its merge lays, or the scar its failed inspection leaves. */
  const ownFloors = (s: SiteState): string[] => [`${s.repo}#job-${s.jobId}`, `${s.repo}#scar-${s.runId}`];

  /**
   * The roof a site stands on: the roof under the run's own floor once the
   * city has laid it (so the frame, the cure and the scar stay on the floor
   * they made), otherwise the tower's top floor (or the root, before any
   * floor): its plan centre, top and half-width.
   */
  function roofOf(piece: Centerpiece, site: SiteState): { x: number; z: number; top: number; half: number } | null {
    piece.object.updateWorldMatrix(true, true);
    let best: { x: number; z: number; top: number; half: number } | null = null;
    const at = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const own = ownFloors(site);
    for (const [o, id] of piece.pickables) {
      o.getWorldPosition(at);
      o.getWorldScale(scale);
      if (id !== null && own.includes(id)) return { x: at.x, z: at.z, top: at.y - scale.y / 2, half: scale.x / 2 };
      const top = at.y + scale.y / 2;
      // The root's proxy reaches three metres past its top; a floor's is the floor.
      const half = id === null ? scale.x / 2 - 3 : scale.x / 2;
      if (!best || top > best.top + 1e-6) best = { x: at.x, z: at.z, top, half };
    }
    return best;
  }

  /** How far the tower reaches past the site's centre on its +x face, root included: the crew's hoist stands off that. */
  function clearOf(piece: Centerpiece, x: number): number {
    let reach = 0;
    const box = new THREE.Box3();
    for (const o of piece.pickables.keys()) {
      o.updateWorldMatrix(true, false);
      box.set(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)).applyMatrix4(o.matrixWorld);
      reach = Math.max(reach, box.max.x - x);
    }
    return reach;
  }

  /** The era of the floor a run laid, once the city has it (the frame cures toward its tone). */
  function eraOf(s: SiteState): Era | null {
    const d = occNow.districts.find((x) => x.repo === s.repo);
    const own = ownFloors(s);
    return d?.tower.floors.find((f) => own.includes(f.id))?.era ?? null;
  }

  function placeConstructions(): void {
    const byRepo = new Map<string, SiteState>();
    for (const s of liveSites) {
      const had = byRepo.get(s.repo);
      if (!had || SITE_RANK[s.stage] > SITE_RANK[had.stage]) byRepo.set(s.repo, s);
    }
    const shown = new Map<string, SiteState>([...byRepo.values()].map((s) => [s.runId, s]));
    // Only a site that really changed is set again; an unrelated event neither recopies a site nor redraws the shadow map.
    let changed = false;
    for (const [runId, entry] of constructions) {
      if (shown.has(runId) && pieceOf(entry.site.repo)) continue;
      // Gone from the market's list: a scar's lamp burns on, and a cure or a strike plays out unless the next run has the roof.
      const lamp = entry.c.workLamp() !== null;
      const finishing = entry.c.busy() && !byRepo.has(entry.site.repo);
      if (pieceOf(entry.site.repo) && (lamp || finishing)) continue;
      entry.c.dispose();
      constructions.delete(runId);
      changed = true;
    }
    for (const s of shown.values()) {
      let entry = constructions.get(s.runId);
      if (!entry) {
        entry = { c: makeConstruction(quality), site: s, top: 0, floorHeight: 0 };
        constructions.set(s.runId, entry);
      }
      entry.site = s;
    }
    for (const entry of constructions.values()) {
      const s = entry.site;
      const piece = pieceOf(s.repo);
      const roof = piece ? roofOf(piece, s) : null;
      if (!roof) continue;
      const floorHeight = FLOOR_HEIGHT[s.size] ?? FLOOR_HEIGHT.medium;
      if (entry.c.object.position.x !== roof.x || entry.c.object.position.z !== roof.z) {
        entry.c.object.position.set(roof.x, 0, roof.z);
        // A site that only moved (its tower rebuilt in place elsewhere) is copied again at its new place.
        entry.c.touch();
        changed = true;
      }
      if (entry.c.set(s, roof.top, roof.half, floorHeight, { era: eraOf(s), clear: clearOf(piece!, roof.x) })) changed = true;
      entry.top = roof.top;
      entry.floorHeight = floorHeight;
    }
    // What stands on the roofs changed: the cached shadow map is drawn again.
    if (changed) sun.shadow.needsUpdate = true;
  }

  function setSites(sites: ReadonlyArray<SiteState>): void {
    liveSites = [...sites];
    placeConstructions();
  }

  // ------------------------------------------------ a merged floor's windows, lit row by row
  /** The panes of a run's new floor on its tower, in the order they light: bottom row first, round the floor from the city's side. */
  const rows = new Map<string, { object: THREE.Object3D; panes: Array<{ mesh: THREE.InstancedMesh; i: number; lit: number }>; shown: number }>();
  const paneColour = new THREE.Color();
  function panesOf(entry: { site: SiteState }, piece: Centerpiece): Array<{ mesh: THREE.InstancedMesh; i: number; lit: number }> {
    piece.object.updateMatrixWorld(true);
    const own = ownFloors(entry.site);
    let band: { y0: number; y1: number; x: number; z: number } | null = null;
    const at = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (const [o, id] of piece.pickables) {
      if (id === null || !own.includes(id)) continue;
      o.getWorldPosition(at);
      o.getWorldScale(scale);
      band = { y0: at.y - scale.y / 2, y1: at.y + scale.y / 2, x: at.x, z: at.z };
    }
    if (!band) return [];
    const out: Array<{ mesh: THREE.InstancedMesh; i: number; lit: number; y: number; a: number }> = [];
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    piece.object.traverse((o) => {
      const im = o as THREE.InstancedMesh;
      if (!im.isInstancedMesh || !im.instanceColor || !(im.material as THREE.Material).customProgramCacheKey?.().startsWith('palimpsest-tower-window')) return;
      for (let i = 0; i < im.count; i++) {
        im.getMatrixAt(i, m);
        p.setFromMatrixPosition(m).applyMatrix4(im.matrixWorld);
        if (p.y < band.y0 || p.y > band.y1) continue;
        im.getColorAt(i, paneColour);
        // Round the floor from the corner the city sees, so the light runs toward the eye.
        const a = (Math.atan2(p.z - band.z, p.x - band.x) - Math.atan2(0.78, 0.63) + Math.PI * 3) % (Math.PI * 2);
        out.push({ mesh: im, i, lit: paneColour.r, y: Math.round((p.y - band.y0) / 0.9), a });
      }
    });
    out.sort((u, v) => u.y - v.y || u.a - v.a);
    return out;
  }
  /** Lights each merged floor's panes up to how far its site has got, and leaves them as the tower built them once all are lit. */
  function lightRows(): void {
    for (const [runId, entry] of constructions) {
      const w = entry.c.finish()?.windows ?? null;
      const piece = pieceOf(entry.site.repo);
      let r = rows.get(runId);
      if (w === null || !piece) {
        rows.delete(runId);
        continue;
      }
      if (r && r.object !== piece.object) r = undefined;
      if (!r) {
        if (w >= 1) continue;
        r = { object: piece.object, panes: panesOf(entry, piece), shown: -1 };
        rows.set(runId, r);
        entry.panes = r.panes.length;
      }
      const n = r.panes.length;
      const shown = Math.round(w * n * 8) / 8;
      if (shown === r.shown) continue;
      r.shown = shown;
      const touched = new Set<THREE.InstancedMesh>();
      r.panes.forEach((pn, k) => {
        // Each pane comes up over an eighth of the run of the floor, so a row reads as switched on, not as a fade.
        const level = THREE.MathUtils.clamp(w * n - k, 0, 1);
        pn.mesh.getColorAt(pn.i, paneColour);
        paneColour.r = pn.lit * level;
        pn.mesh.setColorAt(pn.i, paneColour);
        touched.add(pn.mesh);
      });
      for (const im of touched) im.instanceColor!.needsUpdate = true;
      if (w >= 1) rows.delete(runId);
    }
  }

  const weldAt = new THREE.Vector3();
  const lampColour = new THREE.Color(WORK_LAMP.color);
  const arcColour = new THREE.Color(FLICKER.color);
  /** Runs every site's crane and sparks, hands the pool's lights to the arcs and work lamps nearest the camera, and asks for a shadow redraw while a crane moves. */
  function updateConstructions(dt: number): void {
    const emitters: Array<{ at: THREE.Vector3; intensity: number; d: number; arc: boolean }> = [];
    for (const { c } of constructions.values()) {
      if (c.update(dt)) sun.shadow.needsUpdate = true;
      const w = c.weld();
      if (w) {
        weldAt.copy(w.at).add(c.object.position);
        emitters.push({ at: weldAt.clone(), intensity: w.intensity, d: weldAt.distanceTo(camera.position), arc: true });
      }
      const lamp = c.workLamp();
      if (lamp) {
        const at = lamp.light.add(c.object.position);
        emitters.push({ at, intensity: lamp.intensity, d: at.distanceTo(camera.position), arc: false });
      }
    }
    field.update([...constructions.values()].map((e) => e.c), camera.position);
    lightRows();
    emitters.sort((a, b) => a.d - b.d);
    flickerLights.forEach((l, i) => {
      const a = emitters[i];
      l.intensity = a ? a.intensity : 0;
      if (!a) return;
      l.color.copy(a.arc ? arcColour : lampColour);
      // An arc's light sits just off the steel, on the open side, so it falls on the beam and the deck round the joint.
      if (a.arc) l.position.set(a.at.x, a.at.y + 0.35, a.at.z);
      else l.position.copy(a.at);
    });
  }

  function siteView(repo: string): SiteView | null {
    const s = liveSites.filter((x) => x.repo === repo).sort((a, b) => SITE_RANK[b.stage] - SITE_RANK[a.stage])[0];
    // The site the city shows for the repo: the market's busiest, or the last one still finishing (or burning its lamp).
    const entry = (s && constructions.get(s.runId)) || [...constructions.values()].reverse().find((e) => e.site.repo === repo);
    if (!entry) return null;
    const count = (name: string): { count: number; total: number } => {
      const m = entry.c.object.getObjectByName(name) as THREE.InstancedMesh | undefined;
      return { count: m?.count ?? 0, total: m ? (m.instanceMatrix.count as number) : 0 };
    };
    const crane = entry.c.object.getObjectByName('construction:crane');
    const w = entry.c.weld();
    const st = entry.c.state();
    const fin = entry.c.finish();
    const lamp = entry.c.workLamp();
    const at = entry.c.object.position;
    return {
      stage: entry.site.stage,
      progress: entry.site.progress,
      runId: entry.site.runId,
      columns: count('construction:columns').count,
      beams: count('construction:beams').count,
      beamsTotal: count('construction:beams').total,
      crane: crane ? crane.getWorldPosition(new THREE.Vector3()).toArray() : [],
      weld: w ? w.at.clone().add(at).toArray() : null,
      arc: w ? w.intensity / FLICKER.peak : 0,
      centre: [at.x, at.z],
      top: entry.top,
      floorHeight: entry.floorHeight,
      searchlights: entry.c.searchlights().map((l) => ({ at: l.at.clone().add(at).toArray(), end: l.at.clone().addScaledVector(l.dir, l.length).add(at).toArray() })),
      frameFade: st?.frameFade ?? 0,
      netDrop: st?.netDrop ?? 0,
      strike: st?.strike ?? 0,
      dismantle: st?.dismantle ?? 0,
      floor: fin?.floor ?? null,
      era: fin?.era ?? null,
      windows: fin?.windows ?? null,
      workLamp: lamp ? lamp.at.add(at).toArray() : null,
      busy: entry.c.busy(),
      panes: entry.panes ?? 0,
    };
  }

  let lastPlazas = '';
  function setPlots(occ: Occupancy): number {
    occNow = occ;
    placed = true;
    const built = placeDistricts(occ.districts) + placeQuarters(life.set(occ.quarters), true);
    const wants = campanileStands(occ.districts.map((d) => layoutTower(d.tower).top));
    contact.set(occ.districts.map((d) => ({ x: d.origin.x, z: d.origin.z, half: ROOT_TOP_HALF[d.tower.root] ?? 14, height: layoutTower(d.tower).top })));
    if (wants !== campanile) {
      campanile = wants;
      buildExchange();
    }
    reframe(occ);
    placeSites(sitesStanding(occ));
    // The network grows with the city: its loops enclose every district, quarter and site, a rank at each plaza.
    // The campus too: the loop's street must run outside its terrace, never across it.
    const standing = [...occ.districts.map((d) => d.origin), ...occ.quarters.map((q) => q.origin), ...occ.sites.map((s) => s.origin), ...(campusOrigin ? [campusOrigin] : [])];
    if (standing.length) {
      const extent = { blocks: extentBlocks(standing), districts: occ.districts.map((d) => d.origin) };
      const target = JSON.stringify(extent);
      // Once the city is showing, the network is laid a stretch at a time over the next frames (Task 13); the same
      // extent asked for again while it is being laid leaves that build to finish.
      if (!(spreading() && transitTarget.same(target))) {
        transitTarget.start(target);
        const steps = transitSteps(extent, target);
        if (spreading()) scheduleRemerge(`${owner}transit`, stepper(steps, () => {}));
        else finish(steps);
      }
    }
    // A tower rebuilt (a floor laid, a restyle) may have a new roof: the sites move onto it.
    placeConstructions();
    // The inspection's searchlights streak whatever they sweep: towers, quarters and the blocks round them.
    searchLitTree(districtGroup);
    searchLitTree(schoolRoot);
    // A bankrupt firm's towers take a dead building's dust where the power is off (lightsout.ts); a school tower's masonry
    // and panes too (the zones are positional, so the campus, in the same masonry, is never touched).
    lightsOutTree(districtGroup);
    lightsOutTree(schoolRoot);
    // The skyline is rebuilt only when the set of plazas changed, not on every refresh.
    placeMilestones();
    const key = JSON.stringify(plazasOf(occ)) + (campusOrigin ? `|campus:${campusOrigin.x},${campusOrigin.z}` : '');
    if (key !== lastPlazas) {
      lastPlazas = key;
      updatePlazas(occ);
    } else askShadow();
    return built;
  }

  // ---------------------------------------------------------------- floors: framing and the highlight
  const pieceOf = (repo: string): Centerpiece | null => centerpieces.find((c) => c.repo === repo)?.piece ?? null;

  function floorProxy(repo: string, floorId: string): THREE.Object3D | null {
    // An agent's tower (the ride marks its floors as it passes them): `agent:<id>`.
    if (repo.startsWith('agent:')) {
      const agentId = repo.slice(6);
      for (const { piece } of quarterPieces) for (const [o, id] of piece.pickables) if (id === floorId && piece.agents?.get(o) === agentId) return o;
      return null;
    }
    const piece = pieceOf(repo);
    if (!piece) return null;
    for (const [o, id] of piece.pickables) if (id === floorId) return o;
    return null;
  }

  function floorFrame(repo: string, floorId: string): Frame | null {
    const p = floorProxy(repo, floorId);
    if (!p) return null;
    p.updateWorldMatrix(true, false);
    return { center: p.getWorldPosition(new THREE.Vector3()), width: p.scale.x, height: p.scale.y };
  }

  function towerFrame(repo: string): Frame | null {
    const piece = pieceOf(repo);
    if (!piece) return null;
    piece.object.updateWorldMatrix(true, false);
    const box = new THREE.Box3();
    for (const o of piece.pickables.keys()) {
      o.updateWorldMatrix(true, false);
      // Proxies are unit boxes: their world box is the floor's slice.
      box.union(new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)).applyMatrix4(o.matrixWorld));
    }
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3());
    return { center: box.getCenter(new THREE.Vector3()), width: Math.max(size.x, size.z), height: size.y };
  }

  function rideTower(key: string): RideFloor[] | null {
    const parts: Array<[THREE.Object3D, string | null]> = [];
    if (key.startsWith('agent:')) {
      const agentId = key.slice(6);
      for (const { piece } of quarterPieces) for (const [o, id] of piece.pickables) if (piece.agents?.get(o) === agentId) parts.push([o, id]);
    } else {
      const piece = pieceOf(key);
      if (piece) parts.push(...piece.pickables);
    }
    if (!parts.length) return null;
    const at = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const turn = new THREE.Quaternion();
    const euler = new THREE.Euler();
    const floors = parts.map(([o, id]): RideFloor => {
      o.updateWorldMatrix(true, false);
      o.matrixWorld.decompose(at, turn, scale);
      euler.setFromQuaternion(turn, 'YXZ');
      // The root's proxy reaches three metres past its top on every side.
      return { id, x: at.x, z: at.z, y0: at.y - scale.y / 2, h: scale.y, half: scale.x / 2, ry: euler.y };
    });
    return floors.sort((a, b) => a.y0 - b.y0 || (a.id === null ? -1 : 1));
  }

  function agentFrame(agentId: string): Frame | null {
    for (const { piece } of quarterPieces) {
      const box = new THREE.Box3();
      for (const [o, id] of piece.agents ?? []) {
        if (id !== agentId) continue;
        o.updateWorldMatrix(true, false);
        box.union(new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5)).applyMatrix4(o.matrixWorld));
      }
      if (box.isEmpty()) continue;
      const size = box.getSize(new THREE.Vector3());
      return { center: box.getCenter(new THREE.Vector3()), width: Math.max(size.x, size.z), height: size.y };
    }
    return null;
  }

  let highlighted: { repo: string; floorId: string } | null = null;
  let mark: THREE.Group | null = null;
  const markMaterials = {
    // Pale warm white, under the bloom threshold: it reads as a lit edge, never as neon.
    edge: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.95, 0.82, 0.62), transparent: true }),
    // A faint warm wash on the slice itself, as if that floor were caught in a little more light.
    wash: new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.0, 0.78, 0.5),
      transparent: true,
      opacity: 0.1,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  };
  const markBox = new THREE.BoxGeometry(1, 1, 1);

  function clearMark(): void {
    mark?.removeFromParent();
    mark = null;
  }

  /**
   * A thin band round the top and bottom edges of the floor's slice and down
   * its four corners, plus a faint wash. The band keeps about the same width
   * on screen at any distance: a hairline up close, still legible from across
   * the city.
   */
  function applyHighlight(): void {
    clearMark();
    if (!highlighted) return;
    const p = floorProxy(highlighted.repo, highlighted.floorId);
    if (!p?.parent) return;
    const w = p.scale.x;
    const h = p.scale.y;
    const half = w / 2 + 0.35;
    const g = new THREE.Group();
    g.name = 'floor-highlight';
    g.position.copy(p.position);
    g.rotation.copy(p.rotation);
    const parts: Array<(t: number) => void> = [];
    const add = (mat: THREE.Material, place: (m: THREE.Mesh, t: number) => void): void => {
      const m = new THREE.Mesh(markBox, mat);
      g.add(m);
      parts.push((t) => place(m, t));
    };
    for (const top of [-1, 1]) {
      for (let side = 0; side < 4; side++) {
        const along = side % 2 === 0;
        const sign = side < 2 ? 1 : -1;
        add(markMaterials.edge, (m, t) => {
          const y = top * (h / 2 - t / 2);
          if (along) {
            m.position.set(0, y, sign * half);
            m.scale.set(half * 2 + t, t, t * 0.5);
          } else {
            m.position.set(sign * half, y, 0);
            m.scale.set(t * 0.5, t, half * 2 + t);
          }
        });
      }
    }
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        add(markMaterials.edge, (m, t) => {
          m.position.set(sx * half, 0, sz * half);
          m.scale.set(t * 0.6, h, t * 0.6);
        });
      }
    }
    add(markMaterials.wash, (m) => {
      m.position.set(0, 0, 0);
      m.scale.set(half * 2 - 0.1, h * 0.98, half * 2 - 0.1);
    });
    g.userData.fit = (t: number) => parts.forEach((f) => f(t));
    p.parent.add(g);
    mark = g;
    fitMark();
  }

  const markAt = new THREE.Vector3();
  /** About two and a half pixels of band at the mark's distance, within sane limits. */
  function fitMark(): void {
    if (!mark) return;
    mark.updateWorldMatrix(true, false);
    const d = mark.getWorldPosition(markAt).distanceTo(camera.position);
    const px = (2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / Math.max(1, height());
    (mark.userData.fit as (t: number) => void)(THREE.MathUtils.clamp(px * 2.5, 0.015, 1.4));
  }

  const MARK_EDGE = markMaterials.edge.color.clone();
  const MARK_WASH = markMaterials.wash.color.clone();
  /** The ride's own look for the mark (a bronze tint, faded with its caption), or null for the inspector's. */
  function highlightLook(look: { color: THREE.Color; alpha: number } | null): void {
    markMaterials.edge.color.copy(look ? look.color : MARK_EDGE);
    markMaterials.edge.opacity = look ? look.alpha : 1;
    markMaterials.wash.color.copy(look ? look.color : MARK_WASH);
    markMaterials.wash.opacity = 0.1 * (look ? look.alpha : 1);
  }

  function highlightFloor(repo: string, floorId: string | null): void {
    highlighted = floorId ? { repo, floorId } : null;
    applyHighlight();
  }

  // ---------------------------------------------------------------- picking
  const pickListeners: Array<(hit: PickHit) => void> = [];
  const raycaster = new THREE.Raycaster();
  // Parts past the AO's reach draw on the view's and shadow's layers only (lod.ts): picking tests every layer.
  raycaster.layers.enableAll();
  const pointer = new THREE.Vector2();
  let downAt: { x: number; y: number } | null = null;

  const onPointerDown = (e: PointerEvent): void => {
    downAt = { x: e.clientX, y: e.clientY };
  };
  const onPointerUp = (e: PointerEvent): void => {
    if (!downAt || Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
    downAt = null;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    // Only the pickable parts (tower pick proxies, plinth meshes) are tested, not every piece of tower geometry.
    const hits = raycaster.intersectObjects(allPickables(), false);
    const send = (hit: PickHit): void => {
      for (const fn of pickListeners) fn(hit);
    };
    for (const h of hits) {
      for (const { repo, piece } of centerpieces) {
        let o: THREE.Object3D | null = h.object;
        while (o && !piece.pickables.has(o)) o = o.parent;
        if (o) return send({ kind: 'tower', repo, floorId: piece.pickables.get(o) ?? null });
      }
      for (const { firmId, piece } of quarterPieces) {
        if (!piece.pickables.has(h.object)) continue;
        const agentId = piece.agents?.get(h.object);
        return send(agentId ? { kind: 'agent', agentId, firmId, floorId: piece.pickables.get(h.object) ?? null } : { kind: 'firm', firmId });
      }
      const route = exchange?.pickables.get(h.object);
      if (route) return send({ kind: 'exchange', route });
      const dome = campus?.pickables.get(h.object);
      if (dome === CAMPUS_INSPECT) return send({ kind: 'campus' });
      if (dome) return send({ kind: 'observatory', route: dome });
    }
  };
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointerup', onPointerUp);

  // ---------------------------------------------------------------- inset for a side panel
  let insetTarget = 0;
  let inset = 0;
  function applyInset(): void {
    if (inset < 0.5) camera.clearViewOffset();
    // Shifting the view window right by half the panel puts the view's centre in the middle of what is left uncovered.
    else camera.setViewOffset(width(), height(), inset / 2, 0, width(), height());
  }

  const resize = (): void => {
    renderer.setSize(width(), height());
    rig.setAspect(width() / height());
    relimit(false);
    applyInset();
    post.setSize(width(), height());
  };

  // Towers always hide the plates behind them. The skyline does too from street level, where a name seen
  // through a wall would be wrong; from above the plates read as a map's annotations and stay.
  const plates = createPlates(canvasHost, camera, () => [
    ...allPickables(),
    ...(camera.position.y < STREET_EYE ? grid.blockers : []),
  ]);
  // The personas' plates stand over their figures, hidden behind the same towers.
  const peoplePlates = createPlates(canvasHost, camera, () => [
    ...allPickables(),
    ...(camera.position.y < STREET_EYE ? grid.blockers : []),
  ]);
  const observer = new ResizeObserver(resize);
  observer.observe(canvasHost);

  const lightView = new THREE.Matrix4();
  const lightViewInverse = new THREE.Matrix4();
  const snapped = new THREE.Vector3();
  const shadowAt = new THREE.Vector3(NaN, NaN, NaN);
  const lastTarget = new THREE.Vector3(NaN, NaN, NaN);
  let stillFor = 0;
  function followShadow(dt: number): void {
    // Snap the shadow box centre to whole texels in light space.
    sun.position.copy(rig.controls.target).add(sunOffset);
    sun.target.position.copy(rig.controls.target);
    sun.updateMatrixWorld();
    sun.target.updateMatrixWorld();
    lightView.lookAt(sun.position, sun.target.position, THREE.Object3D.DEFAULT_UP);
    lightViewInverse.copy(lightView).invert();
    snapped.copy(rig.controls.target).applyMatrix4(lightViewInverse);
    snapped.x = Math.round(snapped.x / texel) * texel;
    snapped.y = Math.round(snapped.y / texel) * texel;
    snapped.applyMatrix4(lightView);
    stillFor = rig.controls.target.equals(lastTarget) ? stillFor + dt : 0;
    lastTarget.copy(rig.controls.target);
    // The city stands still: the shadow map is redrawn only when its box moves or what stands in it changes. While the
    // eye moves (a follow, the ride) the box follows it in steps of SHADOW_STEP rather than every texel, so the map is
    // not redrawn every frame (Task 13): on whole texels a shadow falls exactly where it did, and only the box's far
    // edge, SHADOW_HALF away, lags by under a step. Once the eye stops, the box comes to rest exactly where it would have.
    if (!snapped.equals(shadowAt) && shadowBoxMoves(snapped.distanceTo(shadowAt), stillFor)) {
      shadowAt.copy(snapped);
      sun.shadow.needsUpdate = true;
    }
    sun.target.position.copy(shadowAt);
    sun.position.copy(shadowAt).add(sunOffset);
    contact.follow(shadowAt);
  }

  let framesAfterLoad = -1;
  /**
   * The first draw (Task 14). Once the city stands (the first setPlots), its
   * programs are compiled in parallel off the main thread (compileAsync)
   * while nothing is drawn behind the veil; drawn at once, the first frame
   * compiled them one after another on the main thread, two seconds of the
   * first open. `warm` is null until then, false while compiling, true after.
   * Nothing is drawn before the city stands either: the ground and the sky
   * drawn alone first were another 0.6 s of programs compiled in line.
   */
  let placed = false;
  let unplacedFrames = 0;
  let warm: boolean | null = null;
  let warmCap: ReturnType<typeof setTimeout> | undefined;
  function warmUp(): void {
    warm = false;
    const was = renderer.getRenderTarget();
    // Compiled for the target the frame draws the scene into (the composer's), so the first frame finds them made.
    renderer.setRenderTarget(post.sceneTarget);
    const done = (): void => {
      if (warm) return;
      river.compile(renderer, camera);
      warm = true;
    };
    renderer.compileAsync(scene, camera).then(done, done);
    // Never held behind the veil for long: past this the first draw compiles what is left, as before.
    warmCap = setTimeout(done, 6000);
    renderer.setRenderTarget(was);
  }
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (resolveReady = resolve));
  // The city is drawn once the stone, brick and glass are in (materials.ts FIRST_SETS); the paving and the metals land
  // behind the first frame, in the order home needs them.
  void firstTexturesIn().then(() => {
    // The cached shadow map was drawn before the textures arrived (alpha-tested parts included): draw it again, and
    // again once the last of them is in.
    sun.shadow.needsUpdate = true;
    framesAfterLoad = 0;
    void texturesSettled().then(() => (sun.shadow.needsUpdate = true));
  });

  // ---------------------------------------------------------------- towers by distance (lod.ts)
  /**
   * What stands in the districts, judged from the eye each time it moves a
   * few metres: a tower's thin repeated parts hide once under half a pixel
   * wide (never its crown or its lit panes), and anything past AO_NEAR draws
   * in the view and the shadow map but not the AO's normal pass.
   */
  const lodEye = new THREE.Vector3(Infinity, 0, 0);
  let lodSeen = -1;
  const lodSphere = new THREE.Sphere();
  const lodMatrix = new THREE.Matrix4();
  const lodPoint = new THREE.Vector3();
  function districtLod(): boolean {
    if (lodSeen === lodRevision && camera.position.distanceToSquared(lodEye) < 25) return false;
    lodSeen = lodRevision;
    lodEye.copy(camera.position);
    const picks = new Set(allPickables());
    let shadowChanged = false;
    districtGroup.updateMatrixWorld();
    // Every mesh, shown or not: an LOD level switching in, or a part coming back, carries the layers it should.
    districtGroup.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || picks.has(o)) return;
      const inst = mesh as THREE.InstancedMesh;
      if (inst.isInstancedMesh && !inst.boundingSphere) inst.computeBoundingSphere();
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
      const own = inst.isInstancedMesh ? inst.boundingSphere : mesh.geometry.boundingSphere;
      if (!own) return;
      // A batch across the city is judged by its nearest part, not by its whole span (plain-batch.ts).
      const parts = mesh.userData.lodParts as THREE.Sphere[] | undefined;
      let d = Infinity;
      for (const s of parts ?? [own]) d = Math.min(d, Math.max(0, lodSphere.copy(s).applyMatrix4(mesh.matrixWorld).distanceToPoint(camera.position)));
      if (d > AO_NEAR) setLayers(mesh, LAYER.view, LAYER.shadow);
      else mesh.layers.set(0);
    });
    // The skyline's ornaments stand on the towers and keep their rule: past the AO's reach (judged by the nearest
    // ornament each draw holds) they draw in the view and the shadow map, not the AO's normal pass. Their world
    // matrices are brought up to date first: a draw placed this frame is judged where it stands, not where it stood.
    milestones?.group.updateMatrixWorld();
    milestones?.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Its own layers as built, kept to put back when it comes near again.
      const own = (mesh.userData.ownLayers ??= mesh.layers.mask) as number;
      const im = mesh as THREE.InstancedMesh;
      if (im.isInstancedMesh && im.count === 0) return;
      if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
      const r = mesh.geometry.boundingSphere!.radius;
      let d = Infinity;
      if (im.isInstancedMesh) {
        for (let i = 0; i < im.count; i++) {
          im.getMatrixAt(i, lodMatrix);
          lodMatrix.premultiply(im.matrixWorld);
          lodPoint.setFromMatrixPosition(lodMatrix);
          d = Math.min(d, Math.max(0, lodPoint.distanceTo(camera.position) - r * lodMatrix.getMaxScaleOnAxis()));
        }
      } else {
        d = Math.max(0, lodSphere.copy(mesh.geometry.boundingSphere!).applyMatrix4(mesh.matrixWorld).distanceToPoint(camera.position));
      }
      if (d > AO_NEAR) setLayers(mesh, LAYER.view, LAYER.shadow);
      else mesh.layers.mask = own;
    });
    // The view's height for the pieces that hold a least size on screen (the exchange's tote board).
    VIEW_PX.value = height();
    // Thin parts, judged whether shown or hidden now.
    for (const { piece } of centerpieces) {
      piece.object.traverse((o) => {
        const width = o.userData.detailWidth as number | undefined;
        if (width === undefined) return;
        const mesh = o as THREE.InstancedMesh;
        if (!mesh.boundingSphere) mesh.computeBoundingSphere();
        lodSphere.copy(mesh.boundingSphere!).applyMatrix4(mesh.matrixWorld);
        const hidden = detailHidden({ size: width, distance: Math.max(0, lodSphere.distanceToPoint(camera.position)), hidden: !mesh.visible, viewHeight: height() });
        if (hidden === mesh.visible) {
          mesh.visible = !hidden;
          if (mesh.castShadow) shadowChanged = true;
        }
      });
    }
    return shadowChanged;
  }

  const lastFrame = { calls: 0, triangles: 0 };
  /** Each frame's work while traced (debug): ms spent updating, ms submitting the passes, and whether the shadow map redrew. */
  let traced: Array<{ update: number; render: number; shadow: boolean; triangles: number }> | null = null;
  const breakdownWanted: Array<{ detail: boolean; resolve: (b: Breakdown) => void }> = [];
  const shareWanted: Array<{ key: string; resolve: (share: number) => void }> = [];
  const distanceWanted: Array<(d: { width: number; height: number; metres: number[] }) => void> = [];
  /**
   * The distance pass behind distances(): the city drawn with one material that writes each surface's distance from
   * the eye (instances and batches placed as drawn; a shader's own displacement is not honoured), the sky left out.
   */
  function distancePass(): { width: number; height: number; metres: number[] } {
    const w = 480;
    const h = Math.max(1, Math.round(w / Math.max(0.2, width() / height())));
    const rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
    const mat = new THREE.ShaderMaterial({
      toneMapped: false,
      fog: false,
      side: THREE.DoubleSide,
      vertexShader: `
        #include <common>
        #include <batching_pars_vertex>
        varying float vDist;
        void main() {
          #include <batching_vertex>
          #include <begin_vertex>
          #include <project_vertex>
          vDist = length(mvPosition.xyz);
        }`,
      fragmentShader: `
        varying float vDist;
        void main() { gl_FragColor = vec4(min(vDist / ${(255 * DISTANCE_STEP).toFixed(1)}, 1.0), 1.0, 0.0, 1.0); }`,
    });
    const px = new Uint8Array(w * h * 4);
    const was = { target: renderer.getRenderTarget(), override: scene.overrideMaterial, background: scene.background, colour: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(), dome: sky.dome.visible };
    try {
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 0);
      sky.dome.visible = false;
      scene.overrideMaterial = mat;
      scene.background = null;
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    } finally {
      sky.dome.visible = was.dome;
      scene.overrideMaterial = was.override;
      scene.background = was.background;
      renderer.setClearColor(was.colour, was.alpha);
      renderer.setRenderTarget(was.target);
      rt.dispose();
      mat.dispose();
    }
    const metres = new Array<number>(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = ((h - 1 - y) * w + x) * 4;
        metres[y * w + x] = px[i + 1] > 127 ? Math.max(1, px[i]) * DISTANCE_STEP : 0;
      }
    }
    return { width: w, height: h, metres };
  }
  /**
   * The ID pass behind visibleShare, at a small size of the frame's shape: the city drawn as it stands (its own
   * shaders, so every fold, cut and level is honoured) with the root hidden, for its depth; then the root alone in
   * white against that depth (what is visible), and again on a cleared depth (its projected area in the frame).
   */
  function idShare(key: string): number {
    const roots = breakdownRoots().filter(([k]) => k === key).map(([, o]) => o);
    if (!roots.length) return 0;
    const w = 480;
    const h = Math.max(1, Math.round(w / Math.max(0.2, width() / height())));
    const rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
    const white = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    const px = new Uint8Array(w * h * 4);
    const was = { target: renderer.getRenderTarget(), autoClear: renderer.autoClear, override: scene.overrideMaterial, background: scene.background, colour: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha() };
    const shown = roots.map((o) => o.visible);
    const count = (): number => {
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
      let n = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] > 127) n++;
      return n;
    };
    try {
      renderer.setRenderTarget(rt);
      renderer.setClearColor(0x000000, 1);
      renderer.autoClear = false;
      renderer.clear(true, true, true);
      roots.forEach((o) => (o.visible = false));
      renderer.render(scene, camera);
      roots.forEach((o, i) => (o.visible = shown[i]));
      // The root alone, white, against the city's depth.
      const others = scene.children.filter((c) => !roots.includes(c) && c.visible);
      others.forEach((c) => (c.visible = false));
      scene.overrideMaterial = white;
      scene.background = null;
      renderer.clear(true, false, false);
      renderer.render(scene, camera);
      const visible = count();
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
      const projected = count();
      others.forEach((c) => (c.visible = true));
      return projected > 0 ? visible / projected : 0;
    } finally {
      roots.forEach((o, i) => (o.visible = shown[i]));
      scene.overrideMaterial = was.override;
      scene.background = was.background;
      renderer.autoClear = was.autoClear;
      renderer.setClearColor(was.colour, was.alpha);
      renderer.setRenderTarget(was.target);
      rt.dispose();
      white.dispose();
    }
  }
  const breakdownRoots = (): Array<[string, THREE.Object3D]> => [
    ['ambient', grid.group],
    ['river', river.group],
    ['transit', transit.group],
    ['vehicles', vehicleRoot],
    ['traffic', ambientRoot],
    ['people', peopleRoot],
    ['ground', ground.group],
    ['sky', sky.dome],
    ['construction', field.group],
    ['quarters', quarterBatch?.group ?? new THREE.Object3D()],
    ['quarters', life.group],
    ...(exchange ? [['exchange', exchange.object] as [string, THREE.Object3D]] : []),
    ['towers', towerPlains.group],
    ...centerpieces.map(({ piece }) => ['towers', piece.object] as [string, THREE.Object3D]),
    ...(milestones ? [['milestones', milestones.group] as [string, THREE.Object3D]] : []),
    ['campus', campusRoot],
    ['trees', trees.object],
    ['schoolTowers', schoolRoot],
    ...[...scaffolds.values()].map((sc) => ['scaffolds', sc.object] as [string, THREE.Object3D]),
  ];
  const clock = new THREE.Clock();
  const dropListeners: Array<(saw: QualityDrop) => void> = [];
  const governor = qualityGovernor({ start: opts.autoQuality === false ? 'medium' : quality });
  /**
   * A step down while the lens is on (the ride, a follow, a tour stop, the
   * inspector's close view) first lets the depth of field ease off over
   * DOF.ease as it does leaving a close mode, then steps down: medium has no
   * lens, so stepping down at once would cut the blur off in one frame (Task 15).
   */
  let dropWaiting = false;
  function dropQuality(): void {
    if (quality === 'medium') return;
    if (post.lens().on) {
      dropWaiting = true;
      return;
    }
    dropWaiting = false;
    stepDown();
  }
  /** Set by a step down for the rest of its frame: the queue it filled waits for the next. */
  let steppedThisFrame = false;
  function stepDown(): void {
    if (quality === 'medium') return;
    steppedThisFrame = true;
    // Whatever was being rebuilt at high is built again at medium below, at once: the waiting work is let go.
    // The districts and quarters waiting or under way at high are dropped (they are built again at medium below, at
    // once); the ambient blocks and the network, which the drop does not rebuild, are finished now.
    districtJob++;
    quarterJob++;
    quarterWait.clear();
    cancelRemerges(`${owner}districts`);
    cancelRemerges(`${owner}quarters`);
    districtTarget.end(districtTarget.current() ?? '');
    quarterTarget.end(quarterTarget.current() ?? '');
    flushRemerges();
    // What it saw: the window the governor judged, or the last second of frames for a drop asked for by hand.
    const reading = governor.saw ?? governor.reading() ?? { fps: 0, triangles: lastFrame.triangles };
    const fromHome = camera.position.distanceTo(toV(limits.home.eye)) < Math.max(1, limits.homeDistance * 0.05);
    const saw: QualityDrop = { ...reading, fromHome };
    quality = 'medium';
    renderer.setPixelRatio(1);
    renderer.setSize(width(), height());
    post.dispose();
    river.setQuality('medium');
    // The traffic, the streets' life and the facades' rooms step down on the queue, a frame each (Task 15): the rooms'
    // programs recompile on the frame after, and all of it in the step's own frame ran it past 100 ms.
    scheduleRemerge(`${owner}drop:vehicles`, () => vehicles?.setQuality('medium'));
    scheduleRemerge(`${owner}drop:ambient`, () => ambient?.setQuality('medium'));
    scheduleRemerge(`${owner}drop:people`, () => people?.setQuality('medium'));
    scheduleRemerge(`${owner}drop:rooms`, () => setFacadeRooms(false));
    post = createPost(renderer, scene, camera, 'medium', [river.pass(camera)]);
    shadowSize = 2048;
    texel = (SHADOW_HALF * 2) / shadowSize;
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    sun.shadow.needsUpdate = true;
    // The exchange keeps the build it has (Task 15): rebuilt here it was a fifth of a second in one frame, and its
    // few draws at high are not what stepped the city down. It is built at medium the next time it is rebuilt.
    // The rest is rebuilt at medium a piece a frame on the city's queue (Task 15): done all at once, the job sites,
    // the milestones, the campus and every tower (the listeners' rebuild) were one frame of about a second in the
    // middle of a ride.
    // What stood at high draws until its medium build stands in its place.
    scheduleRemerge(`${owner}drop:sites`, () => {
      for (const { c } of constructions.values()) c.dispose();
      constructions.clear();
      rows.clear();
      scene.remove(field.group);
      field.dispose();
      field = makeConstructionField('medium');
      scene.add(field.group);
      placeConstructions();
    });
    scheduleRemerge(`${owner}drop:milestones`, () => {
      if (milestones && opts.milestoneMaterials) {
        milestones.dispose();
        milestones = createMilestones({ quality: 'medium', materials: opts.milestoneMaterials, firmColour: opts.firmColour });
        scene.add(milestones.group);
        placeMilestones();
      }
    });
    scheduleRemerge(`${owner}drop:campus`, () => placeCampus());
    trees.setQuality('medium');
    for (const fn of dropListeners) fn(saw);
  }
  renderer.setAnimationLoop(() => {
    const t0 = traced ? performance.now() : 0;
    const raw = clock.getDelta();
    const dt = Math.min(raw, 0.05);
    // Judged only once the city has loaded and shown its first frames, on the last whole frame's triangles.
    if (framesAfterLoad >= 3 && governor.frame(raw * 1000, lastFrame.triangles) === 'medium') dropQuality();
    if (inset !== insetTarget) {
      inset = Math.abs(insetTarget - inset) < 0.5 ? insetTarget : THREE.MathUtils.damp(inset, insetTarget, 7, dt);
      applyInset();
    }
    eased = easeLimits(eased, limits, dt, camera.position.distanceTo(rig.controls.target));
    easeHome(easedHome, { distance: limits.homeDistance, target: limits.home.target }, dt, easedHome);
    rig.update(dt);
    exchange?.update(dt);
    updateConstructions(dt);
    updateLife(dt);
    milestones?.update(dt, clock.elapsedTime);
    applyLimits();
    // Each chunk of the river draws its detail, casts its shadow and joins the AO pass only near the eye.
    if (river.update(dt, fog.density, camera.position)) sun.shadow.needsUpdate = true;
    if (transit.update(camera.position, fog.density)) sun.shadow.needsUpdate = true;
    // The vehicles move every frame; they cast no sun shadow, so the shadow map is not redrawn for them.
    if (vehicles) {
      vehicles.update(dt, camera.position);
      river.setWakes(vehicles.wakes(camera.position));
    }
    if (ambient) {
      // Once a minute the streets drift toward the hour's density, out of sight.
      if (forcedDensity === null && (densityClock += dt) > 60) {
        densityClock = 0;
        ambient.setDensity(hourDensity(), true);
      }
      // Cars give way to the trams at the tram's crossings, and keep clear of the persona cabs (vehicles.ts),
      // read into arrays kept from frame to frame.
      if (vehicles) {
        const trams = vehicles.vehicles('tram');
        while (tramAt.length < trams.length) tramAt.push({ x: 0, z: 0 });
        tramAt.length = trams.length;
        trams.forEach((t, i) => {
          const p = t.position();
          tramAt[i].x = p[0];
          tramAt[i].z = p[2];
        });
        const cabs = vehicles.vehicles('cab');
        while (cabAt.length < cabs.length) cabAt.push({ x: 0, z: 0, heading: 0, speed: 0 });
        cabAt.length = cabs.length;
        cabs.forEach((c, i) => {
          const p = c.position();
          cabAt[i].x = p[0];
          cabAt[i].z = p[2];
          cabAt[i].heading = c.heading();
          cabAt[i].speed = c.speed();
        });
        ambient.setTrams(tramAt);
        ambient.setCabs(cabAt);
        // One set of lights for the cars and the persona cabs, run on the vehicles' clock (which the cabs plan by),
        // and the cabs queue behind the cars ahead of them.
        ambient.syncSignals(vehicles.clock());
        vehicles.setSignals(ambient.signals());
        if (!trafficSet) {
          const amb = ambient;
          vehicles.setTraffic((x, z, h, reach) => amb.carAhead(x, z, h, reach));
          trafficSet = true;
        }
      }
      ambient.update(dt, camera, renderer.domElement.height);
      // The signal heads at the junctions show the lights the traffic keeps to.
      signalHeads.set(ambient.signals());
      signalHeads.update(camera.position);
    }
    if (people) {
      people.update(dt, camera);
      if (people.platesVersion() !== peoplePlatesVersion) {
        peoplePlatesVersion = people.platesVersion();
        peoplePlates.set(people.plates());
      }
    }
    fitMark();
    plates.update();
    peoplePlates.update();
    frameHooks.run();
    sky.dome.position.copy(camera.position);
    followShadow(dt);
    // The ambient blocks follow the eye (the roof kit's level, the AO's blocks) and the shadow's centre (its casters).
    // And the eye's frustum (Task 12): the view and the AO draw only the blocks it meets.
    if (grid.update(camera.position, sun.target.position, camera)) sun.shadow.needsUpdate = true;
    if (treesDirty) {
      treesDirty = false;
      // Off the transit's stations, stops and ranks: their platforms, stairs and halls stand on those pavements.
      treeSpots = clearOfTransit([...grid.treeSpots(), ...quarterPieces.flatMap(({ q }) => quarterTreeSpots(q.origin)), ...(campus?.treeSpots() ?? [])], transit.network());
      trees.place(treeSpots);
      askShadow();
    }
    if (trees.update({ time: clock.elapsedTime, eye: camera.position })) sun.shadow.needsUpdate = true;
    ground.update(camera.position);
    if (districtLod()) sun.shadow.needsUpdate = true;
    campus?.update(dt, clock.elapsedTime, camera.position);
    campusLiving?.update(dt, clock.elapsedTime);
    schoolTowers?.update(camera.position);
    for (const ask of shareWanted.splice(0)) ask.resolve(idShare(ask.key));
    for (const ask of distanceWanted.splice(0)) ask(distancePass());
    // The lens (ruling 16): the close mode the camera is in and how far its subject stands; none from home or the overview.
    const mode = dropWaiting ? null : lensOverride !== undefined ? lensOverride : focusModeFor({ script: rig.scriptFocus(), following: rig.following(), inspecting: insetTarget > 0 });
    post.setFocus({ mode, distance: camera.position.distanceTo(rig.controls.target), at: rig.controls.target });
    // A step down waiting on the lens goes ahead once the lens is off.
    if (dropWaiting && !post.lens().on) dropQuality();
    // A rebuild waiting out its debounce starts; then the rebuilds take their few milliseconds of this frame (Task 13).
    const due = quarterWait.take(clock.elapsedTime);
    if (due) scheduleRemerge(`${owner}quarters`, stepper(due, () => {}));
    // A rebuild's shadow redraw waits until the rebuilds stand (or SHADOW_COALESCE_S at most): on high one redraw of
    // the 4096 map costs a frame, and a disconnect asked for five of them over a second (Task 13).
    if (shadowAsked >= 0 && (pendingRemerges() === 0 || clock.elapsedTime - shadowAsked > SHADOW_COALESCE_S)) {
      shadowAsked = -1;
      sun.shadow.needsUpdate = true;
    }
    // On high the GPU's frame is near the refresh already: the rebuilds take half the CPU budget there.
    // The frame a step down lands in has done its share: what it queued starts on the next (Task 15).
    if (steppedThisFrame) steppedThisFrame = false;
    else runRemerges(quality === 'high' ? REMERGE_BUDGET_MS / 2 : REMERGE_BUDGET_MS);
    // A city that is never placed (nothing asked for in 3 s of frames) is drawn all the same.
    if (warm === null && (placed || ++unplacedFrames > 180)) warmUp();
    renderer.info.reset();
    const t1 = traced ? performance.now() : 0;
    const shadowing = sun.shadow.needsUpdate;
    if (breakdownWanted.length) {
      sun.shadow.needsUpdate = true;
      const asks = breakdownWanted.splice(0);
      const b = frameBreakdown(renderer, scene, camera, breakdownRoots, () => post.render(), asks.some((a) => a.detail));
      for (const a of asks) a.resolve(b);
    } else if (warm === true) post.render(dt);
    lastFrame.calls = renderer.info.render.calls;
    lastFrame.triangles = renderer.info.render.triangles;
    if (traced) traced.push({ update: t1 - t0, render: performance.now() - t1, shadow: shadowing, triangles: lastFrame.triangles });
    if (framesAfterLoad >= 0 && warm === true && ++framesAfterLoad === 3) resolveReady();
  });

  return {
    scene,
    camera,
    setPlots,
    setPlates: (p) => plates.set(p),
    setBoard(jobs) {
      board = jobs;
      exchange?.setBoard(jobs);
    },
    setStopped(s) {
      stopped = s;
      exchange?.setStopped(s);
    },
    exchange: () => exchange,
    setSites,
    quarterEvent: (e) => {
      life.event(e);
      if (e.kind === 'bankrupt') {
        fallen.add(e.firmId);
        placeMilestones();
      }
    },
    quarterShows: () => life.shows(),
    site: siteView,
    showSites(on) {
      field.group.visible = on;
    },
    highlightFloor,
    floorFrame,
    towerFrame,
    onFrame: (fn) => frameHooks.add(fn),
    frameHooks: () => frameHooks.size(),
    districts: () => occNow.districts.map((d) => d.repo),
    agentFrame,
    setInset(px) {
      insetTarget = Math.max(0, Math.min(px, width() * 0.6));
    },
    precompile: () =>
      renderer.compileAsync(scene, camera).then(() => {
        river.compile(renderer, camera);
      }),
    flyTo: (target, distance) => rig.flyTo(target, distance),
    home: () => rig.flyView(toV(limits.home.eye), toV(limits.home.target)),
    limits: () => ({
      home: { eye: [...limits.home.eye], target: [...limits.home.target] },
      ...eased,
      settled: eased.maxDistance === limits.maxDistance && eased.fogDensity === limits.fogDensity && eased.far === limits.far,
    }),
    haze(k) {
      hazeScale = k === null || !Number.isFinite(k) ? 1 : Math.max(0, k);
      applyLimits();
    },
    onPick(fn) {
      pickListeners.push(fn);
    },
    ready,
    view: (eye, target) => rig.view(eye, target),
    stats: () => ({ ...lastFrame }),
    trace(on) {
      const out = traced ?? [];
      traced = on ? [] : null;
      return out;
    },
    rebuilding: () => pendingRemerges() + (quarterWait.waiting() ? 1 : 0) + (grid.rising() ? 1 : 0),
    longestStep: () => longestRemerge(),
    drawnFloors(repo) {
      const piece = pieceOf(repo);
      return piece ? [...piece.pickables.values()].filter((v) => v !== null).length : -1;
    },
    whenBuilt(fn) {
      builtWaiter = fn;
      settle();
    },
    memory: () => ({ geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures }),
    breakdown: (detail = false) => new Promise<Breakdown>((resolve) => breakdownWanted.push({ detail, resolve })),
    visibleShare: (key) => new Promise<number>((resolve) => shareWanted.push({ key, resolve })),
    distances: () => new Promise((resolve) => distanceWanted.push(resolve)),
    river: () => ({ lamps: river.lamps.length, ...river.view(camera) }),
    plots: () => ({ plazas: ground.plazas(), buildings: grid.buildings() }),
    ambientLots: (x, z, r) => grid.lots(x, z, r),
    transit: () => transit.view(camera),
    vehicles: () => vehicles,
    signalHeads: () => signalHeads.view(),
    transitNetwork: () => transit.network(),
    ambient: () => ambient,
    people: () => people,
    setTrips(trips, agents) {
      pendingTrips.trips = trips;
      pendingTrips.agents = agents;
      people?.set(trips, agents);
    },
    followAgent(agentId) {
      if (!people || agentId === null) {
        people?.follow(null);
        rig.unfollow();
        return;
      }
      people.follow(agentId);
      if (people.following() !== agentId) return;
      // When a tower or a block stands between the eye and the figure's head, the eye is raised until it clears
      // (tested every few frames, by the plates' occluders); it comes down again when the way is clear.
      const ray = new THREE.Raycaster();
      ray.layers.enableAll();
      const head = new THREE.Vector3();
      const dir = new THREE.Vector3();
      let lift = 0;
      let frame = 0;
      rig.follow(
        () => {
          const pose = people?.followPose();
          if (!pose) return null;
          if (frame++ % 6 === 0) {
            head.set(pose.position.x, pose.position.y + 1.6, pose.position.z);
            dir.copy(camera.position).sub(head);
            const d = dir.length();
            if (d > 1e-3) {
              ray.set(head, dir.multiplyScalar(1 / d));
              ray.far = d - 0.5;
              const blocked = ray.intersectObjects([...allPickables(), ...(camera.position.y < STREET_EYE ? grid.blockers : [])], false).length > 0;
              lift = blocked ? Math.min(lift + 2.5, 40) : Math.max(0, lift - 1);
            }
          }
          return { ...pose, lift };
        },
        () => people?.follow(null),
      );
    },
    following: () => people?.following() ?? null,
    rideTower,
    siteHoist(repo) {
      for (const { c, site } of constructions.values()) {
        if (site.repo !== repo) continue;
        const h = c.hoist();
        if (h) return h;
      }
      return null;
    },
    script: (path, onRelease, focus) => rig.script(path, onRelease, focus),
    lens: () => post.lens(),
    lensAs(mode) {
      lensOverride = mode;
    },
    unscript: () => rig.unscript(),
    redrawShadows() {
      sun.shadow.needsUpdate = true;
    },
    flyView: (eye, target) => rig.flyView(eye, target),
    highlightLook,
    viewTarget: () => rig.controls.target.clone(),
    ambientDensity(n) {
      const was = forcedDensity;
      forcedDensity = n === null ? null : Math.max(0, Math.min(1, n));
      ambient?.setDensity(forcedDensity ?? hourDensity());
      return was;
    },
    ambientBoard: (lots) => grid.board(lots),
    board(objects, spots) {
      const group = new THREE.Group();
      group.name = 'board';
      group.add(...objects);
      scene.add(group);
      boardSpots = spots;
      updatePlazas(lastOcc);
      return {
        dispose() {
          scene.remove(group);
          boardSpots = [];
          updatePlazas(lastOcc);
        },
      };
    },
    quality: () => quality,
    dropQuality,
    towerPiece,
    setMilestones(ms) {
      milestoneRows = [...ms];
      placeMilestones();
    },
    milestoneShows: () => milestones?.shows() ?? new Map(),
    showRibbons: (on) => milestones?.ribbons(on),
    showTrees(on) {
      trees.object.visible = on;
      sun.shadow.needsUpdate = true;
    },
    trees: () => ({ spots: treeSpots, ...trees.counts() }),
    setCampusClock(ms) {
      campusClockAt = ms;
    },
    setSchool(s) {
      school = { ...s };
      campus?.setSchool(school);
    },
    observatory: () => campus?.observatory() ?? null,
    setLife(s) {
      lifeState = s;
      campusLiving?.setState(s);
    },
    campusLife: () => campusLiving?.view() ?? null,
    setCampus(origin) {
      const same = (origin === null) === (campusOrigin === null) && (!origin || !campusOrigin || (origin.x === campusOrigin.x && origin.z === campusOrigin.z));
      if (same) return;
      campusOrigin = origin ? { x: origin.x, z: origin.z } : null;
      placeCampus();
      // The block is cleared, the network's loop runs outside it and the home framing holds it.
      lastPlazas = '';
      setPlots(occNow);
    },
    campus: () => (campus && campusOrigin ? { origin: { ...campusOrigin }, anchors: campus.anchors() } : null),
    onQualityDrop(fn) {
      dropListeners.push(fn);
    },
    dispose() {
      // Its waiting rebuilds go with it: the queue is shared, and they would run against what is disposed below.
      cancelRemerges(owner);
      clearTimeout(warmCap);
      renderer.setAnimationLoop(null);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      quarterBatch?.dispose();
      schoolTowers?.dispose();
      towerPlains.dispose();
      exchange?.dispose();
      for (const { piece } of [...centerpieces, ...quarterPieces]) piece.dispose?.();
      centerpieces = [];
      quarterPieces = [];
      for (const sc of scaffolds.values()) sc.dispose();
      scaffolds.clear();
      for (const { c } of constructions.values()) c.dispose();
      constructions.clear();
      rows.clear();
      field.dispose();
      life.dispose();
      plates.dispose();
      peoplePlates.dispose();
      people?.dispose();
      markBox.dispose();
      markMaterials.edge.dispose();
      markMaterials.wash.dispose();
      rig.dispose();
      post.dispose();
      grid.dispose();
      contact.dispose();
      trees.dispose();
      river.dispose();
      transit.dispose();
      vehicles?.dispose();
      if (milestoneTimer) clearTimeout(milestoneTimer);
      milestones?.dispose();
      campus?.dispose();
      campusMasonry?.dispose();
      ambient?.dispose();
      signalHeads.dispose();
      ground.dispose();
      sky.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
