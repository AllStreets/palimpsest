// The framing behind a sheet sets the city's centre in the pane right of the sheet, not behind the paper (audit 2026-11-17).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { paneFraming } from '../tools/pane-framing.js';

function ndcOf(frame: { eye: number[]; target: number[] }, point: number[], aspect: number): THREE.Vector3 {
  const cam = new THREE.PerspectiveCamera(36, aspect, 0.5, 20000);
  cam.position.set(frame.eye[0], frame.eye[1], frame.eye[2]);
  cam.lookAt(frame.target[0], frame.target[1], frame.target[2]);
  cam.updateMatrixWorld();
  return new THREE.Vector3(point[0], point[1], point[2]).project(cam);
}

test("the home framing's target lands at the pane's centre, right of the sheet, from farther back", () => {
  const home = { eye: [540, 380, 960] as [number, number, number], target: [-40, 70, 0] as [number, number, number] };
  const aspect = 1600 / 1000;
  const paneLeft = 752 / 1600;
  const f = paneFraming(home, paneLeft, 1, 36, aspect, 1.4);
  const p = ndcOf(f, home.target, aspect);
  assert.ok(Math.abs(p.x - (paneLeft + 1 - 1)) < 0.01, `at the pane's centre (${p.x.toFixed(3)})`);
  assert.ok(Math.abs(p.y - ndcOf(home, home.target, aspect).y) < 0.05, 'at the height the home framing set it');
  const d0 = Math.hypot(...home.eye.map((v, i) => v - home.target[i]));
  const d1 = Math.hypot(...f.eye.map((v, i) => v - home.target[i]));
  assert.ok(Math.abs(d1 / d0 - 1.4) < 1e-6, 'stepped back to fit the narrower pane');
  // No sheet, no turn.
  const none = paneFraming(home, 0, 1, 36, aspect, 1);
  assert.ok(Math.abs(ndcOf(none, home.target, aspect).x) < 1e-6);
});
