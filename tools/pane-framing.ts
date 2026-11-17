/**
 * The framing behind an open sheet (audit 2026-11-17): the sheet covers the
 * window's left part, so the city shows only in the pane right of it. Every
 * screen still once cropped to the same two towers; this frames the whole
 * skyline in the pane instead. It starts from the home framing (the whole
 * city), steps back by `back` so the skyline's breadth fits the narrower
 * pane, and turns the eye so the city's centre lands at the pane's centre.
 */

import * as THREE from 'three';

type V3 = [number, number, number];

export interface PaneFrame {
  eye: V3;
  target: V3;
}

/**
 * The home framing `home` moved for a pane from `paneLeft` to `paneRight` (fractions of the window's width, 0 to 1),
 * seen through a camera of vertical field `fovDeg` and window aspect `aspect`.
 */
export function paneFraming(home: PaneFrame, paneLeft: number, paneRight: number, fovDeg: number, aspect: number, back: number): PaneFrame {
  const [tx, ty, tz] = home.target;
  const f: V3 = [tx - home.eye[0], ty - home.eye[1], tz - home.eye[2]];
  // Step back along the line of sight, keeping the target.
  const eye: V3 = [tx - f[0] * back, ty - f[1] * back, tz - f[2] * back];
  const fx = tx - eye[0];
  const fz = tz - eye[2];
  const flat = Math.hypot(fx, fz);
  const ux = fx / flat;
  const uz = fz / flat;
  // The camera's right, looking along (ux, 0, uz) with y up: forward cross up.
  const rx = -uz;
  const rz = ux;
  // Turning the line of sight left (toward the sheet) by `yaw` sets what it looked at to the right of the frame.
  const turned = (yaw: number): V3 => {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return [eye[0] + (ux * c - rx * s) * flat, ty, eye[2] + (uz * c - rz * s) * flat];
  };
  // Where the pane's centre is in the view, -1 (left edge) to 1 (right edge). The pitch bends a pure yaw a little,
  // so the turn is refined against the camera's own projection until the target stands there.
  const want = paneLeft + paneRight - 1;
  const cam = new THREE.PerspectiveCamera(fovDeg, aspect, 0.5, 20000);
  const at = (yaw: number): number => {
    const t = turned(yaw);
    cam.position.set(...eye);
    cam.lookAt(...t);
    cam.updateMatrixWorld();
    return new THREE.Vector3(tx, ty, tz).project(cam).x;
  };
  let yaw = Math.atan(want * Math.tan(Math.atan(Math.tan(((fovDeg * Math.PI) / 180) / 2) * aspect)));
  for (let i = 0; i < 8; i++) {
    const got = at(yaw);
    const slope = (at(yaw + 1e-4) - got) / 1e-4;
    if (Math.abs(got - want) < 1e-5 || slope === 0) break;
    yaw -= (got - want) / slope;
  }
  const target = turned(yaw);
  return { eye, target };
}
