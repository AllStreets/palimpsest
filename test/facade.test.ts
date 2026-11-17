import './kit-setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import * as THREE from 'three';

import { FACADE_GLSL } from '../app/src/city/facade.js';
import { cornerLength, cornerU, ROOM, ROOM_GLSL, roomCard, roomLight, roomOf, walkupWindows, type Corner } from '../app/src/city/rooms.js';
import { kitShared } from '../app/src/city/kits.js';
import { SECTIONS } from '../app/src/city/lots.js';
import { CUT } from '../app/src/city/shopfronts.js';
import { BLOOM_THRESHOLD, EXPOSURE } from '../app/src/city/post.js';

// The ambient facades at street level (Phase 5 Task 2): windows round a cut corner keep their width, and every
// window shows a room.

/** The true arc length of a quarter ellipse from angle 0 to `th`, by a fine sum. */
function trueArc(rx: number, rz: number, th: number): number {
  const n = 4000;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const t = ((i + 0.5) / n) * th;
    s += Math.hypot(rx * Math.sin(t), rz * Math.cos(t));
  }
  return (s * th) / n;
}

/** Points along a corner at equal steps of true arc length, as offsets from the corner's inner point. */
function alongCorner(c: Corner, steps: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  if (c.kind === 'chamfer') {
    for (let i = 0; i <= steps; i++) pts.push([c.rx * (1 - i / steps), c.rz * (i / steps)]);
    return pts;
  }
  // The ellipse's angle at each equal share of its arc, found by walking the fine sum.
  const total = trueArc(c.rx, c.rz, Math.PI / 2);
  let k = 0;
  const n = 20000;
  let s = 0;
  pts.push([c.rx, 0]);
  for (let i = 0; i < n && k < steps - 1; i++) {
    const t = ((i + 0.5) / n) * (Math.PI / 2);
    s += (Math.hypot(c.rx * Math.sin(t), c.rz * Math.cos(t)) * (Math.PI / 2)) / n;
    if (s >= ((k + 1) / steps) * total) {
      k++;
      pts.push([c.rx * Math.cos(t), c.rz * Math.sin(t)]);
    }
  }
  pts.push([0, c.rz]);
  return pts;
}

test('cornerU keeps window width within 5% round a chamfer and a quarter round', () => {
  const corners: Corner[] = [
    { kind: 'chamfer', rx: 2.4, rz: 2.4 },
    { kind: 'chamfer', rx: 4.8, rz: 2.1 },
    { kind: 'round', rx: 3.2, rz: 3.2 },
    { kind: 'round', rx: 4.6, rz: 2.9 },
    { kind: 'round', rx: 2.7, rz: 5.1 },
  ];
  for (const c of corners) {
    const name = `${c.kind} ${c.rx} by ${c.rz}`;
    const L = cornerLength(c);
    const expected = c.kind === 'chamfer' ? Math.hypot(c.rx, c.rz) : trueArc(c.rx, c.rz, Math.PI / 2);
    assert.ok(Math.abs(L - expected) / expected < 0.005, `${name}: the corner's length is its arc length (${L.toFixed(3)} against ${expected.toFixed(3)})`);
    assert.ok(Math.abs(cornerU(c.rx, 0, c)) < 1e-6, `${name}: u starts at the x face`);
    assert.ok(Math.abs(cornerU(0, c.rz, c) - L) < 1e-6 * Math.max(1, L), `${name}: u ends at the z face`);
    // Windows a fifth of the corner wide: each spans the same arc, so each keeps the same width in u.
    const pts = alongCorner(c, 20);
    const us = pts.map(([x, z]) => cornerU(x, z, c));
    const widths = us.slice(1).map((u, i) => u - us[i]);
    const mean = L / 20;
    for (const w of widths) assert.ok(Math.abs(w - mean) / mean < 0.05, `${name}: a window of ${mean.toFixed(3)} m reads ${w.toFixed(3)} m (within 5%)`);
    for (let i = 1; i < us.length; i++) assert.ok(us[i] > us[i - 1], `${name}: u rises round the corner`);
  }
  // A square corner's round is a quarter circle.
  const r: Corner = { kind: 'round', rx: 3, rz: 3 };
  assert.ok(Math.abs(cornerLength(r) - (Math.PI / 2) * 3) < 1e-3);
  assert.ok(Math.abs(cornerU(3 * Math.SQRT1_2, 3 * Math.SQRT1_2, r) - (Math.PI / 4) * 3) < 1e-3, 'halfway round at 45 degrees');
});

test("the kit's cut boxes are cut by the fractions the shader maps them with", () => {
  for (const [name, frac] of [
    ['chamfer_box', CUT.chamfer],
    ['round_box', CUT.round],
  ] as const) {
    const g = kitShared(name);
    const p = g.attributes.position as THREE.BufferAttribute;
    let widest = 0;
    let onEdge = 0;
    for (let i = 0; i < p.count; i++) {
      const x = Math.abs(p.getX(i));
      const z = Math.abs(p.getZ(i));
      // On the x = 0.5 edge the box reaches only to 0.5 - cut in z.
      if (Math.abs(x - 0.5) < 1e-4) widest = Math.max(widest, z);
      if (Math.abs(x - 0.5) < 1e-4 && Math.abs(z - (0.5 - frac)) < 1e-3) onEdge++;
    }
    assert.ok(Math.abs(widest - (0.5 - frac)) < 1e-3, `${name}: the cut starts ${frac} of the side in (found ${(0.5 - widest).toFixed(3)})`);
    assert.ok(onEdge > 0, `${name}: the cut meets the face at its start`);
  }
});

test('the same window always shows the same room, and the rooms vary', () => {
  const a = roomOf([3, 2], 0.37);
  const b = roomOf([3, 2], 0.37);
  assert.deepEqual(a, b, 'the room is a function of the window alone');
  const cards = new Set<number>();
  const paints = new Set<number>();
  for (let i = 0; i < 40; i++)
    for (let j = 0; j < 10; j++) {
      const r = roomOf([i + 97, j], 0.61);
      assert.ok(Number.isInteger(r.card) && r.card >= 0 && r.card < ROOM.cards, `card ${r.card} is one of ${ROOM.cards}`);
      assert.ok(Number.isInteger(r.paint) && r.paint >= 0 && r.paint < ROOM.paints, `paint ${r.paint} is one of ${ROOM.paints}`);
      assert.ok(r.depth >= ROOM.depth[0] && r.depth <= ROOM.depth[1], `a room ${r.depth.toFixed(2)} m deep`);
      cards.add(r.card);
      paints.add(r.paint);
    }
  assert.equal(cards.size, ROOM.cards, 'every card is used');
  assert.equal(paints.size, ROOM.paints, 'every paint is used');
  assert.notDeepEqual(roomOf([3, 2], 0.37), roomOf([4, 2], 0.37), 'the next room along differs');
  assert.notDeepEqual(roomOf([3, 2], 0.37), roomOf([3, 2], 0.81), 'another building differs');
});

test("a lit room's furniture card is visible and an unlit one is dim but not black", () => {
  const box = { width: 4.2, ceiling: 2.9, depth: 4.4 };
  const lum = (c: [number, number, number]): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  // Each card covers part of the back wall and reads against the paint behind it.
  for (let card = 0; card < ROOM.cards; card++) {
    let covered = 0;
    let contrast = 0;
    const wall = 0.5;
    for (let x = -1.3; x <= 1.3; x += 0.05)
      for (let y = 0.05; y < box.ceiling; y += 0.05) {
        const c = roomCard(card, [x, y], true);
        if (c.mask > 0.5) {
          covered++;
          contrast = Math.max(contrast, Math.abs(lum(c.colour) - wall));
        }
      }
    assert.ok(covered > 40, `card ${card} covers the wall somewhere (${covered} samples)`);
    assert.ok(contrast > 0.12, `card ${card} reads against the paint (contrast ${contrast.toFixed(2)})`);
    // Nothing in a card is painted black: even its darkest part is lit by the room.
    for (let x = -1.3; x <= 1.3; x += 0.1) {
      const c = roomCard(card, [x, 1.0], false);
      if (c.mask > 0.5) assert.ok(lum(c.colour) > 0.02, `card ${card} at x ${x.toFixed(1)}: not black (${lum(c.colour).toFixed(3)})`);
    }
  }
  // The light: a lit room is brightest under its fitting and still lit at the back wall; an unlit room holds the
  // dusk from the glass, dim at the back but never nothing.
  const back: [number, number, number] = [box.width * 0.5, 1.2, box.depth];
  const nearGlass: [number, number, number] = [box.width * 0.5, 1.2, 0.3];
  const lit = roomLight(true, back, box);
  const dark = roomLight(false, back, box);
  assert.ok(lit > 0.45 && lit < 1.4, `a lit back wall at ${lit.toFixed(2)}`);
  assert.ok(roomLight(true, [box.width * 0.5, box.ceiling - 0.3, box.depth * 0.45], box) > lit, 'brighter under the fitting');
  assert.ok(dark > 0.03 && dark < 0.2, `an unlit back wall is dim but not black (${dark.toFixed(3)})`);
  assert.ok(roomLight(false, nearGlass, box) > dark * 2, 'and lighter toward the glass');
  assert.ok(lit > dark * 4, 'a lit room is many times the unlit one');
  // The far reading (past ROOM.far) keeps an unlit window from going to black as well.
  assert.ok(ROOM.unlitFar > 0.005 && ROOM.unlitFar < 0.05);
});

test('the room shader reads the window and the eye and nothing that moves', () => {
  assert.ok(ROOM_GLSL.includes('roomCard') && ROOM_GLSL.includes('roomLight') && ROOM_GLSL.includes('roomPaint'));
  assert.ok(!/\btime\b|uTime|uClock/.test(ROOM_GLSL), 'no clock in the rooms: a window keeps its room');
  assert.ok(ROOM_GLSL.includes(`ROOM_CARDS ${ROOM.cards.toFixed(1)}`), 'the card count the tests know');
  assert.ok(ROOM.far.high > ROOM.far.medium && ROOM.far.medium > 60, 'rooms are traced near the eye on both tiers, farther on high');
});

test('walkupWindows places the windows the shader draws, bay by bay and floor by floor', () => {
  const s = SECTIONS.walkup;
  const faceW = 20.5;
  const bs = 0.37;
  const h = 21.5;
  const ws = walkupWindows(faceW, bs, h);
  const bayT = 2.2 + bs * 0.6;
  const n = Math.max(1, Math.floor(faceW / bayT + 0.5));
  const cw = faceW / n;
  const floors = Math.floor((h - s.ground - s.parapet) / s.floor);
  assert.equal(ws.length, n * floors, `${n} bays over ${floors} floors`);
  for (const w of ws) {
    assert.ok(w.u0 >= 0 && w.u1 <= faceW && w.u1 > w.u0, 'within the face');
    assert.ok(Math.abs(w.u1 - w.u0 - 0.38 * cw) < 1e-6, 'a window is 38% of its bay');
    assert.ok(w.y0 >= s.ground && w.y1 <= h - s.parapet + 1e-6, 'above the shopfront and under the parapet');
    assert.ok(Math.abs(w.y1 - w.y0 - 0.58 * s.floor) < 1e-6, 'and 58% of its storey tall');
  }
});

test('a room trace never steps behind the glass: every plane distance in the facade program is held at or above zero', () => {
  // The navy debug: the shop's trace ran for the fascia over the glass too, above the room's ceiling, where the ceiling
  // lies behind the view ray. On a near-level ray its distance was a huge negative number, the point it gave stood a
  // hundred kilometres behind the glass, the room's light there overflowed (exp) and inf times nought drew NaN, which
  // the bloom spread into a rectangle the page showed through (#090b12), on high only (medium skips the trace).
  const decls = [...FACADE_GLSL.matchAll(/float (t[SCF]) = ([^;]+);/g)];
  assert.equal(decls.length, 6, 'two traces (the shop and the upper rooms), each with a side wall, a ceiling and a floor');
  for (const [, name, expr] of decls) {
    assert.match(expr.trim(), /^max\(.*, 0\.0\)$/s, `${name} = ${expr.slice(0, 50)}... may be negative`);
  }
});

test('a room never lights past the dusk at its glass: the light has a ceiling wherever the trace lands, under the bloom threshold', () => {
  // The final review's campus-quad still (I2): a glass block's upper room, seen on a near-level ray from the quad's
  // eye 30 m up, took the ceiling plane behind the ray (the fault the navy debug fixed in the trace). The point stood
  // far behind the glass, the unlit room's dusk term exp(-z * 0.35) overflowed, and the floor's whole band of windows
  // burned white with the bloom over the library's gable. The trace now never steps behind the glass; the light term
  // holds its own ceiling too, so no landing point, however the trace finds it, lights a room past the glass.
  const box = { width: 3.2, ceiling: 3.3, depth: 4.5 };
  const atGlass = roomLight(false, [1.6, 1.5, 0], box);
  for (const z of [-0.5, -10, -1e3, -1e5]) {
    const behind = roomLight(false, [1.6, 1.5, z], box);
    assert.ok(Number.isFinite(behind) && behind <= atGlass + 1e-9, `a point ${-z} m behind the glass lights no brighter than the glass (${behind} against ${atGlass.toFixed(3)})`);
  }
  for (const z of [0, 1, box.depth, 1e3]) assert.ok(roomLight(false, [1.6, 1.5, z], box) <= atGlass + 1e-9, `nor any point in the room (${z} m in)`);
  // The brightest an unlit room can be after exposure: the palest wall (the ceiling's 0.7) at the glass, in the dusk's
  // own tint (its bluest channel, 0.78): under the bloom threshold, so no unlit window band blooms.
  assert.ok(0.7 * atGlass * 0.78 * EXPOSURE < BLOOM_THRESHOLD, `an unlit room stays under the bloom threshold (${(0.7 * atGlass * 0.78 * EXPOSURE).toFixed(3)})`);
  // Both shader terms of the dusk through the glass hold the depth at zero or more: ROOM_GLSL's roomLight and the shop's.
  assert.match(ROOM_GLSL, /float rz = clamp\(P\.z, 0\.0, box\.z\);[\s\S]*exp\(-rz \* 0\.35\)[\s\S]*\(1\.0 - rz \/ box\.z\)/, 'roomLight in ROOM_GLSL holds its depth inside the room');
  assert.doesNotMatch(ROOM_GLSL, /exp\(-P\.z/, 'and reads no unheld depth');
  const shop = [...FACADE_GLSL.matchAll(/room \*= exp\(([^;]+)\)/g)];
  assert.equal(shop.length, 1, "the shop's room fades with its depth once");
  assert.match(shop[0][1], /^-max\(P\.z, 0\.0\) \*/, `the shop's fade holds its depth at or above zero (${shop[0][1]})`);
});
