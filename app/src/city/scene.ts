import * as THREE from 'three';

import type { District } from '../../../shared/types';
import { ROOT_HEIGHT } from '../../../shared/tower-layout';
import { createCameraRig } from './camera';
import { createGrid } from './grid';
import { createGround, makePlinth } from './ground';
import { createPlates, type Plate } from './labels';
import { configureMaterials, texturesSettled } from './materials';
import { createPost } from './post';
import { makeScaffold, type Scaffold } from './scaffold';
import { createSky, HORIZON_FOG, installSkyFog, SUN_DIRECTION } from './sky';

export interface PickHit {
  kind: 'tower';
  repo: string;
  floorId: string | null;
}

/** What stands at a district's origin, and which of its parts can be clicked (mapped to a floor id, or null). */
export interface Centerpiece {
  object: THREE.Object3D;
  pickables: Map<THREE.Object3D, string | null>;
  dispose?(): void;
}

export type CenterpieceFactory = (d: District) => Centerpiece;

export interface CityOptions {
  quality: 'high' | 'medium';
  /** Builds what stands in each district. Defaults to a plain stone plinth; towers plug in here. */
  makeDistrictCenterpiece?: CenterpieceFactory;
}

/** A district site whose first analysis is still running: no tower yet, a scaffold stands there. */
export interface Site {
  repo: string;
  origin: { x: number; z: number };
}

/** Where a floor or a whole tower stands in the world, for framing the camera on it. */
export interface Frame {
  center: THREE.Vector3;
  width: number;
  height: number;
}

export interface City {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  /** Shows these districts. Only districts that changed are rebuilt; returns how many were built. */
  setDistricts(d: District[]): number;
  /** Shows a scaffold at each site. */
  setSites(sites: Site[]): void;
  /** Sets the street-level name plates. */
  setPlates(plates: Plate[]): void;
  /** Marks one floor of a district's tower, or clears the mark with null. Survives the district being rebuilt. */
  highlightFloor(repo: string, floorId: string | null): void;
  floorFrame(repo: string, floorId: string): Frame | null;
  towerFrame(repo: string): Frame | null;
  /** Keeps the view centred in the part of the window not covered by a panel this wide on the right. */
  setInset(px: number): void;
  /** Compiles every material for the current scene so later frames never stall on a shader compile. */
  precompile(): Promise<void>;
  flyTo(target: THREE.Vector3, distance: number): void;
  onPick(fn: (hit: PickHit) => void): void;
  dispose(): void;
  /** Resolves once textures have loaded and the first frames are on screen. */
  ready: Promise<void>;
  /** Jumps the camera to an eye and target (tests and debugging). */
  view(eye: THREE.Vector3, target: THREE.Vector3): void;
  /** Draw calls and triangles in the last whole frame, every pass included. */
  stats(): { calls: number; triangles: number };
}

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

/** Fog density: thick enough to swallow the city's far edge into the horizon colour. */
const FOG_DENSITY = 0.00055;
const SHADOW_HALF = 320;
/** Below this eye height the skyline hides name plates behind it. */
const STREET_EYE = 80;

/**
 * The city at dusk: the sky dome and the environment lit from it, horizon
 * fog, a low warm sun with soft shadows that follow the view, the ground
 * and street grid, the ambient skyline, and one centerpiece per district.
 */
export function createCity(canvasHost: HTMLElement, opts: CityOptions): City {
  const quality = opts.quality;
  installSkyFog();
  const makeCenterpiece = opts.makeDistrictCenterpiece ?? (() => plinthCenterpiece());

  const width = (): number => Math.max(1, canvasHost.clientWidth);
  const height = (): number => Math.max(1, canvasHost.clientHeight);

  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  // 1.75 on retina keeps 60 fps at full window size on the M5 Pro; the difference from 2 is not visible through the post chain.
  renderer.setPixelRatio(Math.min(devicePixelRatio, quality === 'high' ? 1.75 : 1));
  renderer.setSize(width(), height());
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.85;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  // Counted per frame across the whole post chain, not per render call.
  renderer.info.autoReset = false;
  // Focusable by script only, so closing a panel can hand focus back to the city.
  renderer.domElement.tabIndex = -1;
  canvasHost.appendChild(renderer.domElement);
  configureMaterials(renderer);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(HORIZON_FOG.getHex(), FOG_DENSITY);

  const rig = createCameraRig(renderer.domElement, width() / height());
  const camera = rig.camera;

  const sky = createSky(renderer);
  scene.add(sky.dome);
  scene.environment = sky.environment;
  scene.environmentIntensity = 1.0;

  // Key light: the last of the sun, low and warm. Its shadow box follows the view, snapped to texels so edges do not crawl.
  const sun = new THREE.DirectionalLight(0xff9c5e, 2.4);
  sun.castShadow = true;
  const shadowSize = quality === 'high' ? 4096 : 2048;
  sun.shadow.mapSize.set(shadowSize, shadowSize);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  Object.assign(sun.shadow.camera, { left: -SHADOW_HALF, right: SHADOW_HALF, top: SHADOW_HALF, bottom: -SHADOW_HALF, near: 10, far: 1600 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.autoUpdate = false;
  sun.shadow.needsUpdate = true;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0x8fa3c8, 0x2e241c, 0.35));
  const sunOffset = SUN_DIRECTION.clone().multiplyScalar(800);
  const texel = (SHADOW_HALF * 2) / shadowSize;

  const ground = createGround();
  scene.add(ground.mesh);
  const grid = createGrid(quality);
  scene.add(grid.group);

  const post = createPost(renderer, scene, camera, quality);

  // ---------------------------------------------------------------- districts
  const districtGroup = new THREE.Group();
  districtGroup.name = 'districts';
  scene.add(districtGroup);
  let centerpieces: Array<{ repo: string; key: string; piece: Centerpiece }> = [];
  let scaffolds = new Map<string, Scaffold>();
  let districtOrigins: Array<{ x: number; z: number; rootHeight: number }> = [];
  let siteOrigins: Array<{ x: number; z: number }> = [];
  let framed = false;

  function frameOverview(districts: District[]): void {
    const c = new THREE.Vector3();
    for (const d of districts) c.add(new THREE.Vector3(d.origin.x, 0, d.origin.z));
    if (districts.length > 0) c.divideScalar(districts.length);
    const spread = districts.reduce((m, d) => Math.max(m, Math.hypot(d.origin.x - c.x, d.origin.z - c.z)), 0);
    const dist = 300 + spread * 1.2;
    // The mockup's bearing: the afterglow off to the left, sunlit faces turned partly toward the eye.
    const bearing = new THREE.Vector3(0.63, 0.15, 0.78).normalize();
    const target = c.clone().setY(55);
    rig.view(target.clone().addScaledVector(bearing, dist), target);
  }

  function updatePlazas(): void {
    // A site under scaffold is cleared and paved like any district.
    const plazas = [...districtOrigins, ...siteOrigins];
    grid.setPlazas(plazas);
    ground.setPlazas(plazas);
    // Towers, scaffolds and the skyline around them may all have changed.
    sun.shadow.needsUpdate = true;
  }

  function setDistricts(districts: District[]): number {
    // A district whose data is unchanged keeps its built tower; only new or changed ones are built.
    const old = new Map(centerpieces.map((c) => [c.repo, c]));
    let built = 0;
    centerpieces = districts.map((d) => {
      const key = JSON.stringify(d);
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
    districtOrigins = districts.map((d) => ({ x: d.origin.x, z: d.origin.z, rootHeight: ROOT_HEIGHT[d.tower.root] }));
    updatePlazas();
    if (highlighted) applyHighlight();
    if (!framed) {
      frameOverview(districts);
      framed = true;
    }
    return built;
  }

  function setSites(sites: Site[]): void {
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
    siteOrigins = sites.map((s) => ({ ...s.origin }));
    updatePlazas();
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
    const targets = centerpieces.flatMap(({ piece }) => [...piece.pickables.keys()]);
    const hits = raycaster.intersectObjects(targets, false);
    for (const h of hits) {
      for (const { repo, piece } of centerpieces) {
        let o: THREE.Object3D | null = h.object;
        while (o && !piece.pickables.has(o)) o = o.parent;
        if (o) {
          const hit: PickHit = { kind: 'tower', repo, floorId: piece.pickables.get(o) ?? null };
          for (const fn of pickListeners) fn(hit);
          return;
        }
      }
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
    applyInset();
    post.setSize(width(), height());
  };

  // Towers always hide the plates behind them. The skyline does too from street level, where a name seen
  // through a wall would be wrong; from above the plates read as a map's annotations and stay.
  const plates = createPlates(canvasHost, camera, () => [
    ...centerpieces.flatMap(({ piece }) => [...piece.pickables.keys()]),
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
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    if (inset !== insetTarget) {
      inset = Math.abs(insetTarget - inset) < 0.5 ? insetTarget : THREE.MathUtils.damp(inset, insetTarget, 7, dt);
      applyInset();
    }
    rig.update(dt);
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
    setDistricts,
    setSites,
    setPlates: (p) => plates.set(p),
    highlightFloor,
    floorFrame,
    towerFrame,
    setInset(px) {
      insetTarget = Math.max(0, Math.min(px, width() * 0.6));
    },
    precompile: () => renderer.compileAsync(scene, camera).then(() => undefined),
    flyTo: (target, distance) => rig.flyTo(target, distance),
    onPick(fn) {
      pickListeners.push(fn);
    },
    ready,
    view: (eye, target) => rig.view(eye, target),
    stats: () => ({ ...lastFrame }),
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      for (const { piece } of centerpieces) piece.dispose?.();
      centerpieces = [];
      for (const sc of scaffolds.values()) sc.dispose();
      scaffolds.clear();
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
