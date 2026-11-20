/**
 * The screens' tokens hold by test, not by eye: every ink reads at 4.5:1 over
 * the panel's thinnest ground laid on the city's brightest pixel, and on the
 * pins' and lock's backplate; the state colours stay apart; tokens.css says
 * exactly what tokens.ts says; parallax is clamped and opposed by depth.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { contrast, hex, over, type Rgb } from '../app/src/ui/contrast.js';
import { COLOUR, cssTokens, GROUND, MOTION, parallaxOffset, PLATE, TONE_INK, type ColourToken } from '../app/src/ui/os/tokens.js';

/** The city's brightest pixel, bounded above. */
const BRIGHTEST: Rgb = [255, 255, 255];

/** Every colour that is ever set as text, red included (the lock's and the grant's words). */
const TEXT: ColourToken[] = ['ink', 'ink2', 'dim', 'amber', 'amberHi', 'red', 'ice', 'ok', 'warn', 'fail', 'benched'];

test('every ink holds 4.5:1 over the thinnest ground on the brightest city', () => {
  const ground = over(BRIGHTEST, GROUND.rgb, GROUND.textMinAlpha);
  for (const c of TEXT) {
    const r = contrast(hex(COLOUR[c]), ground);
    assert.ok(r >= 4.5, `${c} ${COLOUR[c]} is ${r.toFixed(2)}:1 over the ground at alpha ${GROUND.textMinAlpha}`);
  }
});

test('every ink holds 4.5:1 on the pins and lock backplate over the brightest city', () => {
  const plate = over(BRIGHTEST, PLATE.rgb, PLATE.alpha);
  for (const c of TEXT) {
    const r = contrast(hex(COLOUR[c]), plate);
    assert.ok(r >= 4.5, `${c} ${COLOUR[c]} is ${r.toFixed(2)}:1 on the backplate at alpha ${PLATE.alpha}`);
  }
});

test('every tone inks in a colour that is a token', () => {
  for (const [tone, ink] of Object.entries(TONE_INK)) assert.ok(ink in COLOUR, `${tone} inks in ${ink}`);
});

test('the state colours are distinct', () => {
  const states: ColourToken[] = ['ok', 'warn', 'fail', 'benched', 'red'];
  for (let i = 0; i < states.length; i++) {
    for (let j = i + 1; j < states.length; j++) {
      const [a, b] = [hex(COLOUR[states[i]]), hex(COLOUR[states[j]])];
      const d = Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
      assert.ok(d >= 40, `${states[i]} and ${states[j]} are only ${d} apart`);
    }
  }
});

test('tokens.css declares exactly what tokens.ts says', () => {
  const css = readFileSync(new URL('../app/src/ui/os/tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const root = /(?:^|\})\s*:root\s*\{([^{}]*)\}/.exec(css);
  assert.ok(root, 'tokens.css has a :root rule');
  const declared: Record<string, string> = {};
  for (const decl of root[1].split(';')) {
    const at = decl.indexOf(':');
    if (at < 0) continue;
    declared[decl.slice(0, at).trim()] = decl.slice(at + 1).trim().replace(/\s+/g, ' ');
  }
  assert.deepEqual(declared, cssTokens());
});

test('parallax is clamped and opposed by depth', () => {
  const rect = { left: 100, top: 50, width: 400, height: 200 };
  const edge = { x: 500, y: 150 };
  const outside = { x: 800, y: 150 };
  const centre = { x: 300, y: 150 };
  assert.equal(parallaxOffset(edge, rect, 'near').x, 5);
  assert.equal(parallaxOffset(edge, rect, 'far').x, -7);
  for (const d of ['near', 'mid', 'far'] as const) {
    assert.deepEqual(parallaxOffset(outside, rect, d), parallaxOffset(edge, rect, d), `${d} is clamped at the edge`);
    assert.deepEqual(parallaxOffset(centre, rect, d), { x: 0, y: 0 }, `${d} rests at the centre`);
  }
  assert.deepEqual(parallaxOffset({ x: 100, y: 250 }, rect, 'near'), { x: -5, y: 3.5 });
  assert.deepEqual(parallaxOffset({ x: 100, y: 50 }, rect, 'far'), { x: 7, y: 5 });
  for (const p of [edge, outside, centre, { x: -900, y: 9000 }]) assert.deepEqual(parallaxOffset(p, rect, 'mid'), { x: 0, y: 0 });
});

test('type-in never outlasts its limit', () => {
  assert.ok(MOTION.typeMaxMs <= 600);
});
