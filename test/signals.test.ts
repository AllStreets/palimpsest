import assert from 'node:assert/strict';
import { test } from 'node:test';

import { greenIn, greenLeft, SIGNAL, SIGNAL_CYCLE, signalAt, signalJunction, signalPhase, signalsOf } from '../app/src/city/signals.js';
import { aspectOf, headsOf, SIGNAL_CORNER } from '../app/src/city/signal-heads.js';

test('a junction runs x green, amber, all red, z green, amber, all red, and says go only on its own axis', () => {
  const j = signalJunction(200, -120);
  assert.equal(SIGNAL_CYCLE, SIGNAL.gx + SIGNAL.gz + 2 * (SIGNAL.amber + SIGNAL.allRed));
  let goX = 0;
  let goZ = 0;
  let both = 0;
  for (let t = 0; t < SIGNAL_CYCLE; t += 0.05) {
    const x = signalAt(j, t, 'x') === 'go';
    const z = signalAt(j, t, 'z') === 'go';
    if (x) goX += 0.05;
    if (z) goZ += 0.05;
    if (x && z) both++;
  }
  assert.equal(both, 0, 'never both ways at once');
  assert.ok(Math.abs(goX - (SIGNAL.gx + SIGNAL.amber)) < 0.2 && Math.abs(goZ - (SIGNAL.gz + SIGNAL.amber)) < 0.2, `go for green and amber (${goX.toFixed(1)} s, ${goZ.toFixed(1)} s)`);
  // The same junction is the same lights on every load; neighbours change at their own moments.
  assert.deepEqual(signalJunction(200, -120), j);
  assert.notEqual(signalJunction(280, -120).offset - j.offset, -8, 'a little play of its own beyond the green wave');
});

test('greenIn and greenLeft agree with the phase', () => {
  const j = signalJunction(-40, 360);
  for (let t = 0; t < 2 * SIGNAL_CYCLE; t += 0.7) {
    for (const axis of ['x', 'z'] as const) {
      const p = signalPhase(j, t);
      const green = p.green === axis && !p.amber;
      assert.equal(greenIn(j, t, axis) === 0, green, `at ${t.toFixed(1)} s along ${axis}`);
      if (!green) {
        const w = greenIn(j, t, axis);
        const q = signalPhase(j, t + w + 0.01);
        assert.ok(q.green === axis && !q.amber, `green ${w.toFixed(2)} s on`);
        assert.equal(greenLeft(j, t, axis), 0);
      } else assert.ok(greenLeft(j, t, axis) > 0);
    }
  }
  const s = signalsOf([j], () => 12);
  assert.equal(s.at(-40, 360), j);
  assert.equal(s.at(40, 360), null);
  assert.equal(s.now(), 12);
});

test('each junction has a head on every corner facing the traffic it is for, showing its light', () => {
  const j = signalJunction(120, 40);
  const heads = headsOf(j);
  assert.equal(heads.length, 4);
  for (const h of heads) {
    // On the pavement's corner, just behind the kerb (4 m off each centre line).
    assert.ok(Math.abs(Math.abs(h.x - j.x) - SIGNAL_CORNER) < 1e-9 && Math.abs(Math.abs(h.z - j.z) - SIGNAL_CORNER) < 1e-9);
    assert.ok(SIGNAL_CORNER > 4.3 && SIGNAL_CORNER < 6.5, 'behind the kerb, short of the crossing');
    // The head's face (its local +x turned by yaw about y: cos yaw, -sin yaw) looks back along its approach.
    const face = { x: Math.cos(h.yaw), z: -Math.sin(h.yaw) };
    const along = h.axis === 'x' ? face.x : face.z;
    const across = h.axis === 'x' ? face.z : face.x;
    assert.ok(Math.abs(Math.abs(along) - 1) < 1e-9 && Math.abs(across) < 1e-9, 'it faces along its street');
    // The traffic it faces comes toward it, keeping right: the head stands on that traffic's right-hand kerb.
    const travel = { x: -face.x, z: -face.z };
    const right = { x: -travel.z, z: travel.x };
    assert.ok((h.x - j.x) * right.x + (h.z - j.z) * right.z > 0, 'on the right of the traffic it is for');
    assert.ok((h.x - j.x) * travel.x + (h.z - j.z) * travel.z < 0, 'on the near side of the junction');
  }
  for (let t = 0; t < SIGNAL_CYCLE; t += 0.5) {
    const p = signalPhase(j, t);
    for (const h of heads) {
      const a = aspectOf(p, h.axis);
      assert.equal(a === 0, signalAt(j, t, h.axis) === 'stop', 'red exactly when its traffic must stop');
      assert.equal(a === 1, p.green === h.axis && p.amber);
    }
  }
});
