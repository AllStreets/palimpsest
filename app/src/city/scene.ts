import * as THREE from 'three';

import type { District } from '../../../shared/types';
import { createCameraRig } from './camera';
import { createGrid } from './grid';
import { createGround, makePlinth } from './ground';
import { configureMaterials, texturesSettled } from './materials';
import { createPost } from './post';
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

export interface City {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  setDistricts(d: District[]): void;
  flyTo(target: THREE.Vector3, distance: number): void;
  onPick(fn: (hit: PickHit) => void): void;
  dispose(): void;
  /** Resolves once textures have loaded and the first frames are on screen. */
  ready: Promise<void>;
  /** Jumps the camera to an eye and target (tests and debugging). */
  view(eye: THREE.Vector3, target: THREE.Vector3): void;
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
  let centerpieces: Array<{ repo: string; piece: Centerpiece }> = [];
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

  function setDistricts(districts: District[]): void {
    for (const { piece } of centerpieces) {
      districtGroup.remove(piece.object);
      piece.dispose?.();
    }
    centerpieces = districts.map((d) => {
      const piece = makeCenterpiece(d);
      piece.object.position.set(d.origin.x, 0, d.origin.z);
      piece.object.userData.repo = d.repo;
      districtGroup.add(piece.object);
      return { repo: d.repo, piece };
    });
    const plazas = districts.map((d) => ({ x: d.origin.x, z: d.origin.z }));
    grid.setPlazas(plazas);
    ground.setPlazas(plazas);
    if (!framed) {
      frameOverview(districts);
      framed = true;
    }
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
    const hits = raycaster.intersectObject(districtGroup, true);
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

  // ---------------------------------------------------------------- loop
  const resize = (): void => {
    renderer.setSize(width(), height());
    rig.setAspect(width() / height());
    post.setSize(width(), height());
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvasHost);

  const lightView = new THREE.Matrix4();
  const lightViewInverse = new THREE.Matrix4();
  const snapped = new THREE.Vector3();
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
  }

  let framesAfterLoad = -1;
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => (resolveReady = resolve));
  void texturesSettled().then(() => {
    framesAfterLoad = 0;
  });

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 0.05);
    rig.update(dt);
    sky.dome.position.copy(camera.position);
    followShadow();
    post.render();
    if (framesAfterLoad >= 0 && ++framesAfterLoad === 3) resolveReady();
  });

  return {
    scene,
    camera,
    setDistricts,
    flyTo: (target, distance) => rig.flyTo(target, distance),
    onPick(fn) {
      pickListeners.push(fn);
    },
    ready,
    view: (eye, target) => rig.view(eye, target),
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      for (const { piece } of centerpieces) piece.dispose?.();
      centerpieces = [];
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
