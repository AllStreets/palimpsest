import * as THREE from 'three';

import { QUARTER_OFFSETS } from '../../../shared/district-layout.js';
import { FLOOR_HEIGHT } from '../../../shared/tower-layout.js';
import type { District, Quarter, SiteStage, SiteState } from '../../../shared/types';
import { batchPieces, type Batched } from './batch.js';
import { createCameraRig } from './camera';
import { makeConstruction, type Construction } from './construction.js';
import type { BoardJob, Exchange } from './exchange.js';
import { createGrid } from './grid';
import { createGround, makePlinth } from './ground';
import { createPlates, type Plate } from './labels';
import type { Lot } from './lots';
import { configureMaterials, texturesSettled } from './materials';
import { plazasOf, type Occupancy, type SiteSpot } from './occupancy.js';
import { qualityGovernor } from './governor';
import { createPost, EXPOSURE, FLICKER } from './post';
import { makeScaffold, type Scaffold } from './scaffold';
import { createSky, HORIZON_FOG, installSkyFog, SUN_DIRECTION } from './sky';
import { cityExtent, easeLimits, fogFor, opensHome, viewLimits, type EasedLimits, type ViewLimits } from './view';

/** What a click in the city landed on: a district's tower (a floor, or its root), an agent's tower in a quarter, or a firm's plinth. */
export type PickHit =
  | { kind: 'tower'; repo: string; floorId: string | null }
  | { kind: 'agent'; agentId: string; firmId: string; floorId: string | null }
  | { kind: 'firm'; firmId: string }
  | { kind: 'exchange'; route: string };

/** What stands at a district's origin, and which of its parts can be clicked (mapped to a floor id, or null). */
export interface Centerpiece {
  object: THREE.Object3D;
  pickables: Map<THREE.Object3D, string | null>;
  /** In a quarter: each pickable part of an agent's tower, mapped to its agent (the rest picks as the firm). */
  agents?: Map<THREE.Object3D, string>;
  dispose?(): void;
}

export type CenterpieceFactory = (d: District) => Centerpiece;
export type QuarterFactory = (q: Quarter) => Centerpiece;

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
  makeExchange?: (quality: 'high' | 'medium') => Exchange;
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
  onPick(fn: (hit: PickHit) => void): void;
  dispose(): void;
  /** Resolves once textures have loaded and the first frames are on screen. */
  ready: Promise<void>;
  /** Jumps the camera to an eye and target (tests and debugging). */
  view(eye: THREE.Vector3, target: THREE.Vector3): void;
  /** Draw calls and triangles in the last whole frame, every pass included. */
  stats(): { calls: number; triangles: number };
  /** Plazas the ground paves (the civic plaza included) and ambient buildings standing (tests and debugging). */
  plots(): { plazas: number; buildings: number };
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
  onQualityDrop(fn: () => void): void;
}

/** A job site as the city shows it. */
export interface SiteView {
  stage: SiteStage;
  progress: number;
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
/** Below this eye height the skyline hides name plates behind it. */
const STREET_EYE = 80;

/**
 * The city at dusk: the sky dome and the environment lit from it, horizon
 * fog, a low warm sun with soft shadows that follow the view, the ground
 * and street grid, the ambient skyline, and one centerpiece per district.
 */
export function createCity(canvasHost: HTMLElement, opts: CityOptions): City {
  let quality = opts.quality;
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
  const sunOffset = SUN_DIRECTION.clone().multiplyScalar(800);
  let texel = (SHADOW_HALF * 2) / shadowSize;

  const sunNeedsUpdate = (): void => {
    sun.shadow.needsUpdate = true;
  };
  const ground = createGround();
  scene.add(ground.mesh);
  const grid = createGrid(quality);
  scene.add(grid.group);

  let post = createPost(renderer, scene, camera, quality);

  // ---------------------------------------------------------------- the civic exchange
  // Built once on the plaza at the origin, and again at medium if the city steps down; it keeps the board and the switch.
  let exchange: Exchange | null = null;
  let board: ReadonlyArray<BoardJob> = [];
  let stopped = false;
  function buildExchange(): void {
    if (!opts.makeExchange) return;
    if (exchange) {
      scene.remove(exchange.object);
      exchange.dispose();
    }
    exchange = opts.makeExchange(quality);
    exchange.setBoard(board);
    exchange.setStopped(stopped);
    scene.add(exchange.object);
    sunNeedsUpdate();
    rebatchQuarters();
  }

  // ---------------------------------------------------------------- districts
  const districtGroup = new THREE.Group();
  districtGroup.name = 'districts';
  scene.add(districtGroup);
  let centerpieces: Array<{ repo: string; key: string; piece: Centerpiece }> = [];
  let quarterPieces: Array<{ firmId: string; key: string; piece: Centerpiece }> = [];
  /** Every pickable part in the city: towers' floors and roots, quarters' towers and plinths. */
  const allPickables = (): THREE.Object3D[] => [...[...centerpieces, ...quarterPieces].flatMap(({ piece }) => [...piece.pickables.keys()]), ...(exchange ? exchange.pickables.keys() : [])];
  let scaffolds = new Map<string, Scaffold>();
  let framed = false;

  // ---------------------------------------------------------------- the view grows with the city
  // The limits follow the districts standing: the home framing changes at once (it is only used when asked
  // for), while how far the camera may go, the haze and the far plane ease over a second or two. The camera
  // itself is never moved for the city's sake once it has opened.
  let extent = cityExtent([]);
  let limits: ViewLimits = viewLimits(extent, width() / height());
  let eased: EasedLimits = { maxDistance: limits.maxDistance, fogDensity: limits.fogDensity, far: limits.far };
  /** The home distance the haze thins against, eased with the rest so a growing city never makes it jump. */
  let easedHome = limits.homeDistance;
  function relimit(snap: boolean): void {
    limits = viewLimits(extent, width() / height());
    if (snap) {
      eased = { maxDistance: limits.maxDistance, fogDensity: limits.fogDensity, far: limits.far };
      easedHome = limits.homeDistance;
    }
  }
  const homeTarget = new THREE.Vector3();
  const applyLimits = (): void => {
    rig.controls.maxDistance = eased.maxDistance;
    // Flown out past home the haze thins, so the whole city still reads from as far as the camera may go.
    const fromCity = camera.position.distanceTo(homeTarget.set(limits.home.target[0], limits.home.target[1], limits.home.target[2]));
    fog.density = fogFor(eased.fogDensity, easedHome, fromCity);
    if (camera.far !== eased.far) {
      camera.far = eased.far;
      camera.updateProjectionMatrix();
    }
  };
  applyLimits();
  const toV = (v: number[]): THREE.Vector3 => new THREE.Vector3(v[0], v[1], v[2]);

  /** Spots the board stands on, cleared like plots. */
  let boardSpots: Array<{ x: number; z: number }> = [];
  let lastOcc: Occupancy = { districts: [], sites: [], quarters: [] };
  function updatePlazas(occ: Occupancy): void {
    lastOcc = occ;
    // Only occupied plots are paved and cleared: a district, or a site under scaffold (and the board's spots).
    const plazas = [...plazasOf(occ, opts.districtTones), ...boardSpots.map((b) => ({ x: b.x, z: b.z }))];
    grid.setPlazas(plazas);
    ground.setPlazas(plazas);
    // Towers, scaffolds and the skyline around them may all have changed.
    sun.shadow.needsUpdate = true;
  }

  function placeDistricts(districts: District[]): number {
    // A district whose data is unchanged keeps its built tower; only new or changed ones are built.
    const old = new Map(centerpieces.map((c) => [c.repo, c]));
    let built = 0;
    centerpieces = districts.map((d) => {
      const key = JSON.stringify(d) + (opts.centerpieceKey?.(d) ?? '');
      const kept = old.get(d.repo);
      if (kept && kept.key === key) {
        old.delete(d.repo);
        return kept;
      }
      const piece = makeCenterpiece(d);
      piece.object.position.set(d.origin.x, 0, d.origin.z);
      piece.object.userData.repo = d.repo;
      districtGroup.add(piece.object);
      built++;
      return { repo: d.repo, key, piece };
    });
    for (const { piece } of old.values()) {
      districtGroup.remove(piece.object);
      piece.dispose?.();
    }
    if (highlighted) applyHighlight();
    return built;
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
    if (quarterBatch) {
      districtGroup.remove(quarterBatch.group);
      quarterBatch.dispose();
      quarterBatch = null;
    }
    const roots = [...quarterPieces.map(({ piece }) => piece.object), ...(exchange?.statics ?? [])];
    if (roots.length === 0) return;
    for (const r of roots) r.visible = true;
    districtGroup.updateMatrixWorld(true);
    exchange?.object.updateMatrixWorld(true);
    quarterBatch = batchPieces(roots);
    quarterBatch.group.name = 'quarters';
    for (const r of roots) r.visible = false;
    districtGroup.add(quarterBatch.group);
  }

  function placeQuarters(quarters: Quarter[]): number {
    const old = new Map(quarterPieces.map((c) => [c.firmId, c]));
    let built = 0;
    quarterPieces = quarters.map((q) => {
      const key = JSON.stringify(q) + (opts.quarterKey?.(q) ?? '');
      const kept = old.get(q.firmId);
      if (kept && kept.key === key) {
        old.delete(q.firmId);
        return kept;
      }
      const piece = opts.makeQuarterCenterpiece?.(q) ?? { object: new THREE.Group(), pickables: new Map() };
      piece.object.position.set(q.origin.x, 0, q.origin.z);
      piece.object.userData.firmId = q.firmId;
      districtGroup.add(piece.object);
      built++;
      return { firmId: q.firmId, key, piece };
    });
    const removed = old.size;
    for (const { piece } of old.values()) {
      districtGroup.remove(piece.object);
      piece.dispose?.();
    }
    if (built > 0 || removed > 0) rebatchQuarters();
    return built;
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
    extent = cityExtent([...occ.districts, ...agents]);
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
  const constructions = new Map<string, { c: Construction; top: number; floorHeight: number }>();

  /** The roof a tower's next floor goes on: its top floor's plan centre, top and half-width (or the root's, before any floor). */
  function roofOf(piece: Centerpiece): { x: number; z: number; top: number; half: number } | null {
    piece.object.updateWorldMatrix(true, true);
    let best: { x: number; z: number; top: number; half: number } | null = null;
    const at = new THREE.Vector3();
    const scale = new THREE.Vector3();
    for (const [o, id] of piece.pickables) {
      o.getWorldPosition(at);
      o.getWorldScale(scale);
      const top = at.y + scale.y / 2;
      // The root's proxy reaches three metres past its top; a floor's is the floor.
      const half = id === null ? scale.x / 2 - 3 : scale.x / 2;
      if (!best || top > best.top + 1e-6) best = { x: at.x, z: at.z, top, half };
    }
    return best;
  }

  function placeConstructions(): void {
    const byRepo = new Map<string, SiteState>();
    for (const s of liveSites) {
      const had = byRepo.get(s.repo);
      if (!had || SITE_RANK[s.stage] > SITE_RANK[had.stage]) byRepo.set(s.repo, s);
    }
    for (const [repo, entry] of constructions) {
      if (byRepo.has(repo) && pieceOf(repo)) continue;
      districtGroup.remove(entry.c.object);
      entry.c.dispose();
      constructions.delete(repo);
    }
    for (const [repo, s] of byRepo) {
      const piece = pieceOf(repo);
      const roof = piece ? roofOf(piece) : null;
      if (!roof) continue;
      let entry = constructions.get(repo);
      if (!entry) {
        entry = { c: makeConstruction(quality), top: 0, floorHeight: 0 };
        districtGroup.add(entry.c.object);
        constructions.set(repo, entry);
      }
      const floorHeight = FLOOR_HEIGHT[s.size] ?? FLOOR_HEIGHT.medium;
      entry.c.object.position.set(roof.x, 0, roof.z);
      entry.c.set(s, roof.top, roof.half, floorHeight);
      entry.top = roof.top;
      entry.floorHeight = floorHeight;
    }
    // What stands on the roofs changed: the cached shadow map is drawn again.
    sun.shadow.needsUpdate = true;
  }

  function setSites(sites: ReadonlyArray<SiteState>): void {
    liveSites = [...sites];
    placeConstructions();
  }

  const weldAt = new THREE.Vector3();
  /** Runs every site's crane and sparks, hands the pool's lights to the arcs nearest the camera, and asks for a shadow redraw while a crane moves. */
  function updateConstructions(dt: number): void {
    const arcs: Array<{ at: THREE.Vector3; intensity: number; d: number }> = [];
    for (const { c } of constructions.values()) {
      if (c.update(dt)) sun.shadow.needsUpdate = true;
      const w = c.weld();
      if (!w) continue;
      weldAt.copy(w.at).add(c.object.position);
      arcs.push({ at: weldAt.clone(), intensity: w.intensity, d: weldAt.distanceTo(camera.position) });
    }
    arcs.sort((a, b) => a.d - b.d);
    flickerLights.forEach((l, i) => {
      const a = arcs[i];
      l.intensity = a ? a.intensity : 0;
      // Just off the steel, on the open side, so the light falls on the beam and the deck round the joint.
      if (a) l.position.set(a.at.x, a.at.y + 0.35, a.at.z);
    });
  }

  function siteView(repo: string): SiteView | null {
    const entry = constructions.get(repo);
    const s = liveSites.filter((x) => x.repo === repo).sort((a, b) => SITE_RANK[b.stage] - SITE_RANK[a.stage])[0];
    if (!entry || !s) return null;
    const count = (name: string): { count: number; total: number } => {
      const m = entry.c.object.getObjectByName(name) as THREE.InstancedMesh | undefined;
      return { count: m?.count ?? 0, total: m ? (m.instanceMatrix.count as number) : 0 };
    };
    const crane = entry.c.object.getObjectByName('construction:crane');
    const w = entry.c.weld();
    return {
      stage: s.stage,
      progress: s.progress,
      columns: count('construction:columns').count,
      beams: count('construction:beams').count,
      beamsTotal: count('construction:beams').total,
      crane: crane ? crane.getWorldPosition(new THREE.Vector3()).toArray() : [],
      weld: w ? w.at.clone().add(entry.c.object.position).toArray() : null,
      arc: w ? w.intensity / FLICKER.peak : 0,
      centre: [entry.c.object.position.x, entry.c.object.position.z],
      top: entry.top,
      floorHeight: entry.floorHeight,
    };
  }

  let lastPlazas = '';
  function setPlots(occ: Occupancy): number {
    const built = placeDistricts(occ.districts) + placeQuarters(occ.quarters);
    reframe(occ);
    placeSites(occ.sites);
    // A tower rebuilt (a floor laid, a restyle) may have a new roof: the sites move onto it.
    placeConstructions();
    // The skyline is rebuilt only when the set of plazas changed, not on every refresh.
    const key = JSON.stringify(plazasOf(occ));
    if (key !== lastPlazas) {
      lastPlazas = key;
      updatePlazas(occ);
    } else sun.shadow.needsUpdate = true;
    return built;
  }

  // ---------------------------------------------------------------- floors: framing and the highlight
  const pieceOf = (repo: string): Centerpiece | null => centerpieces.find((c) => c.repo === repo)?.piece ?? null;

  function floorProxy(repo: string, floorId: string): THREE.Object3D | null {
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
    edge: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.95, 0.82, 0.62) }),
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
    (mark.userData.fit as (t: number) => void)(THREE.MathUtils.clamp(px * 2.5, 0.06, 1.4));
  }

  function highlightFloor(repo: string, floorId: string | null): void {
    highlighted = floorId ? { repo, floorId } : null;
    applyHighlight();
  }

  // ---------------------------------------------------------------- picking
  const pickListeners: Array<(hit: PickHit) => void> = [];
  const raycaster = new THREE.Raycaster();
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
  const observer = new ResizeObserver(resize);
  observer.observe(canvasHost);

  const lightView = new THREE.Matrix4();
  const lightViewInverse = new THREE.Matrix4();
  const snapped = new THREE.Vector3();
  const shadowAt = new THREE.Vector3(NaN, NaN, NaN);
  function followShadow(): void {
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
    sun.target.position.copy(snapped);
    sun.position.copy(snapped).add(sunOffset);
    // The city stands still: the shadow map is redrawn only when its box moves or what stands in it changes.
    if (!snapped.equals(shadowAt)) {
      shadowAt.copy(snapped);
      sun.shadow.needsUpdate = true;
    }
  }

  let framesAfterLoad = -1;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (resolveReady = resolve));
  void texturesSettled().then(() => {
    // The cached shadow map was drawn before the textures arrived (alpha-tested parts included): draw it again.
    sun.shadow.needsUpdate = true;
    framesAfterLoad = 0;
  });

  const lastFrame = { calls: 0, triangles: 0 };
  const clock = new THREE.Clock();
  const dropListeners: Array<() => void> = [];
  const governor = qualityGovernor({ start: opts.autoQuality === false ? 'medium' : quality });
  function dropQuality(): void {
    if (quality === 'medium') return;
    quality = 'medium';
    renderer.setPixelRatio(1);
    renderer.setSize(width(), height());
    post.dispose();
    post = createPost(renderer, scene, camera, 'medium');
    shadowSize = 2048;
    texel = (SHADOW_HALF * 2) / shadowSize;
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
    sun.shadow.mapSize.set(shadowSize, shadowSize);
    sun.shadow.needsUpdate = true;
    buildExchange();
    for (const { c } of constructions.values()) {
      districtGroup.remove(c.object);
      c.dispose();
    }
    constructions.clear();
    placeConstructions();
    for (const fn of dropListeners) fn();
  }
  renderer.setAnimationLoop(() => {
    const raw = clock.getDelta();
    const dt = Math.min(raw, 0.05);
    // Judged only once the city has loaded and shown its first frames, on the last whole frame's triangles.
    if (framesAfterLoad >= 3 && governor.frame(raw * 1000, lastFrame.triangles) === 'medium') dropQuality();
    if (inset !== insetTarget) {
      inset = Math.abs(insetTarget - inset) < 0.5 ? insetTarget : THREE.MathUtils.damp(inset, insetTarget, 7, dt);
      applyInset();
    }
    eased = easeLimits(eased, limits, dt, camera.position.distanceTo(rig.controls.target));
    easedHome = THREE.MathUtils.damp(easedHome, limits.homeDistance, 3, dt);
    rig.update(dt);
    exchange?.update(dt);
    updateConstructions(dt);
    applyLimits();
    fitMark();
    plates.update();
    sky.dome.position.copy(camera.position);
    followShadow();
    renderer.info.reset();
    post.render();
    lastFrame.calls = renderer.info.render.calls;
    lastFrame.triangles = renderer.info.render.triangles;
    if (framesAfterLoad >= 0 && ++framesAfterLoad === 3) resolveReady();
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
    site: siteView,
    highlightFloor,
    floorFrame,
    towerFrame,
    agentFrame,
    setInset(px) {
      insetTarget = Math.max(0, Math.min(px, width() * 0.6));
    },
    precompile: () => renderer.compileAsync(scene, camera).then(() => undefined),
    flyTo: (target, distance) => rig.flyTo(target, distance),
    home: () => rig.flyView(toV(limits.home.eye), toV(limits.home.target)),
    limits: () => ({
      home: { eye: [...limits.home.eye], target: [...limits.home.target] },
      ...eased,
      settled: eased.maxDistance === limits.maxDistance && eased.fogDensity === limits.fogDensity && eased.far === limits.far,
    }),
    onPick(fn) {
      pickListeners.push(fn);
    },
    ready,
    view: (eye, target) => rig.view(eye, target),
    stats: () => ({ ...lastFrame }),
    plots: () => ({ plazas: ground.plazas(), buildings: grid.buildings() }),
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
    onQualityDrop(fn) {
      dropListeners.push(fn);
    },
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      quarterBatch?.dispose();
      exchange?.dispose();
      for (const { piece } of [...centerpieces, ...quarterPieces]) piece.dispose?.();
      centerpieces = [];
      quarterPieces = [];
      for (const sc of scaffolds.values()) sc.dispose();
      scaffolds.clear();
      for (const { c } of constructions.values()) c.dispose();
      constructions.clear();
      plates.dispose();
      markBox.dispose();
      markMaterials.edge.dispose();
      markMaterials.wash.dispose();
      rig.dispose();
      post.dispose();
      grid.dispose();
      ground.dispose();
      sky.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
