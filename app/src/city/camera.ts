import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** The eye never drops below standing height. */
const MIN_EYE_HEIGHT = 1.7;
const FLIGHT_SECONDS = 1.6;
/** Following a figure: the eye this far behind and above it, looking a little ahead of it, eased at these rates per second. */
const FOLLOW = { back: 10.4, up: 6, ahead: 2.5, eyeRate: 2.2, targetRate: 4, turnRate: 1.6 } as const;

/** Where a followed figure stands and faces (people.ts): x forward is (cos heading, sin heading). */
export interface FollowPose {
  position: THREE.Vector3;
  heading: number;
}

export interface CameraRig {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** Glides to look at `target` from `distance` away, keeping the current bearing. */
  flyTo(target: THREE.Vector3, distance: number): void;
  /** Glides to an eye and target. */
  flyView(eye: THREE.Vector3, target: THREE.Vector3): void;
  /** Jumps straight to an eye and target. */
  view(eye: THREE.Vector3, target: THREE.Vector3): void;
  /**
   * Keeps the eye 12 m behind and above whatever `pose` answers, easing
   * after it, until the user drags or scrolls, unfollow() is called, or
   * `pose` answers null (the trip ended, the agent retired). `onRelease` is
   * told whichever way it lets go.
   */
  follow(pose: () => FollowPose | null, onRelease?: () => void): void;
  unfollow(): void;
  following(): boolean;
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

  let follow: { pose: () => FollowPose | null; onRelease?: () => void; heading: number; started: boolean; last: THREE.Vector3 } | null = null;
  const release = (): void => {
    if (!follow) return;
    const done = follow.onRelease;
    follow = null;
    done?.();
  };
  const stopFlight = (): void => {
    flight = null;
    // A drag or a scroll is the user taking the camera back.
    release();
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
    follow(pose, onRelease) {
      flight = null;
      follow = { pose, onRelease, heading: 0, started: false, last: new THREE.Vector3() };
    },
    unfollow: release,
    following: () => follow !== null,
    update(dt) {
      if (follow) {
        const p = follow.pose();
        if (!p) release();
        else {
          // The bearing turns after the figure's heading the short way round, slowly enough that a corner does not swing the view.
          if (!follow.started) {
            follow.heading = p.heading;
            follow.last.copy(p.position);
            follow.started = true;
          }
          // The eye eases after the figure, so on a tram it would fall behind: it aims ahead by the way the figure moves.
          const lead = dt > 1e-4 ? Math.min(1 / FOLLOW.eyeRate, 2) : 0;
          const vx = dt > 1e-4 ? ((p.position.x - follow.last.x) / dt) * lead : 0;
          const vz = dt > 1e-4 ? ((p.position.z - follow.last.z) / dt) * lead : 0;
          follow.last.copy(p.position);
          let d = p.heading - follow.heading;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          follow.heading += d * Math.min(1, 1 - Math.exp(-FOLLOW.turnRate * dt));
          const fx = Math.cos(follow.heading);
          const fz = Math.sin(follow.heading);
          const eye = new THREE.Vector3(p.position.x - fx * FOLLOW.back + vx, Math.max(MIN_EYE_HEIGHT, p.position.y + FOLLOW.up), p.position.z - fz * FOLLOW.back + vz);
          const target = new THREE.Vector3(p.position.x + fx * FOLLOW.ahead + vx * 0.5, p.position.y + 1.4, p.position.z + fz * FOLLOW.ahead + vz * 0.5);
          const ke = 1 - Math.exp(-FOLLOW.eyeRate * dt);
          const kt = 1 - Math.exp(-FOLLOW.targetRate * dt);
          camera.position.lerp(eye, ke);
          controls.target.lerp(target, kt);
        }
      }
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
