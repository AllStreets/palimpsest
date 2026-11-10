import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** The eye never drops below standing height. */
const MIN_EYE_HEIGHT = 1.7;
const FLIGHT_SECONDS = 1.6;

export interface CameraRig {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** Glides to look at `target` from `distance` away, keeping the current bearing. */
  flyTo(target: THREE.Vector3, distance: number): void;
  /** Glides to an eye and target. */
  flyView(eye: THREE.Vector3, target: THREE.Vector3): void;
  /** Jumps straight to an eye and target. */
  view(eye: THREE.Vector3, target: THREE.Vector3): void;
  update(dt: number): void;
  setAspect(aspect: number): void;
  dispose(): void;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * A 36 degree lens (close to a 50 mm on full frame: no wide-angle
 * distortion on the towers), orbit controls with damping, and smooth flights
 * between targets. How far the camera may fly out and where the far plane
 * sits are the city's to set (see view.ts); these are only where they start.
 */
export function createCameraRig(dom: HTMLElement, aspect: number): CameraRig {
  const camera = new THREE.PerspectiveCamera(36, aspect, 0.5, 20000);
  camera.position.set(420, 160, 520);
  const controls = new OrbitControls(camera, dom);
  controls.target.set(120, 30, 120);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 12;
  controls.maxDistance = 2600;
  controls.zoomSpeed = 0.8;
  controls.update();

  let flight: {
    t: number;
    fromEye: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toEye: THREE.Vector3;
    toTarget: THREE.Vector3;
  } | null = null;

  const stopFlight = (): void => {
    flight = null;
  };
  dom.addEventListener('pointerdown', stopFlight);
  dom.addEventListener('wheel', stopFlight, { passive: true });

  return {
    camera,
    controls,
    flyTo(target, distance) {
      const dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() < 1e-6) dir.set(1, 0.5, 1);
      dir.normalize();
      flight = {
        t: 0,
        fromEye: camera.position.clone(),
        fromTarget: controls.target.clone(),
        toEye: target.clone().addScaledVector(dir, distance),
        toTarget: target.clone(),
      };
      flight.toEye.y = Math.max(flight.toEye.y, MIN_EYE_HEIGHT);
    },
    flyView(eye, target) {
      flight = { t: 0, fromEye: camera.position.clone(), fromTarget: controls.target.clone(), toEye: eye.clone(), toTarget: target.clone() };
      flight.toEye.y = Math.max(flight.toEye.y, MIN_EYE_HEIGHT);
    },
    view(eye, target) {
      flight = null;
      camera.position.copy(eye);
      controls.target.copy(target);
      controls.update();
    },
    update(dt) {
      if (flight) {
        flight.t = Math.min(flight.t + dt / FLIGHT_SECONDS, 1);
        const k = easeInOutCubic(flight.t);
        camera.position.lerpVectors(flight.fromEye, flight.toEye, k);
        controls.target.lerpVectors(flight.fromTarget, flight.toTarget, k);
        if (flight.t >= 1) flight = null;
      }
      controls.update();
      if (camera.position.y < MIN_EYE_HEIGHT) camera.position.y = MIN_EYE_HEIGHT;
    },
    setAspect(a) {
      camera.aspect = a;
      camera.updateProjectionMatrix();
    },
    dispose() {
      dom.removeEventListener('pointerdown', stopFlight);
      dom.removeEventListener('wheel', stopFlight);
      controls.dispose();
    },
  };
}
