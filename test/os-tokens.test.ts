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

// ---------------------------------------------------------------- the keys' words on their own faces

/**
 * A small reader for control.css: its top-level rules (no @media), each
 * declaration's value, and the colours they name, resolved through the
 * tokens. Enough for the forms control.css uses: var(--os-x),
 * rgba(var(--os-x-rgb), a), rgba(0, 0, 0, a), white, black, color-mix(in srgb,
 * ...), and linear-gradient stops.
 */
const CONTROL = readFileSync(new URL('../app/src/ui/os/control.css', import.meta.url), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');

/** Splits on commas outside brackets. */
function args(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** The declarations of the top-level rule whose selector list holds `selector` exactly; later wins. */
function decls(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of CONTROL.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!args(m[1].trim()).includes(selector)) continue;
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i > 0) out[d.slice(0, i).trim()] = d.slice(i + 1).trim().replace(/\s+/g, ' ');
    }
  }
  return out;
}

/** The cascade over rules in rising specificity: each later rule's declarations win. */
const cascade = (...selectors: string[]): Record<string, string> => Object.assign({}, ...selectors.map(decls));

type Paint = { rgb: Rgb; a: number };
const TOKENS = cssTokens();

/** One colour expression, resolved through the tokens. */
function paint(expr: string): Paint {
  const e = expr.trim();
  if (e === 'white') return { rgb: [255, 255, 255], a: 1 };
  if (e === 'black') return { rgb: [0, 0, 0], a: 1 };
  if (e === 'transparent' || e === 'none') return { rgb: [0, 0, 0], a: 0 };
  let m = /^var\((--os-[\w-]+)\)$/.exec(e);
  if (m) {
    assert.ok(TOKENS[m[1]], `no token ${m[1]}`);
    return { rgb: hex(TOKENS[m[1]]), a: 1 };
  }
  m = /^rgba?\(var\((--os-[\w-]+-rgb)\),\s*([\d.]+)\)$/.exec(e);
  if (m) {
    const rgb = TOKENS[m[1]].split(',').map(Number) as unknown as Rgb;
    return { rgb, a: Number(m[2]) };
  }
  m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/.exec(e);
  if (m) return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])], a: m[4] === undefined ? 1 : Number(m[4]) };
  m = /^color-mix\((.*)\)$/.exec(e);
  if (m) {
    const [space, x, y] = args(m[1]);
    assert.equal(space, 'in srgb', `color-mix in ${space}`);
    const part = (s: string): { c: Paint; p?: number } => {
      const pm = /^(.*?)\s+([\d.]+)%$/.exec(s);
      return pm ? { c: paint(pm[1]), p: Number(pm[2]) / 100 } : { c: paint(s) };
    };
    const [px, py] = [part(x), part(y)];
    const wx = px.p ?? (py.p !== undefined ? 1 - py.p : 0.5);
    const mix = (i: number): number => Math.round(px.c.rgb[i] * wx + py.c.rgb[i] * (1 - wx));
    return { rgb: [mix(0), mix(1), mix(2)], a: 1 };
  }
  throw new Error(`control.css colour the test cannot read: ${e}`);
}

/** Every colour that can sit under text in a background: each gradient stop, or the one colour. */
function grounds(background: string | undefined): Paint[] {
  if (!background) return [paint('none')];
  const m = /^linear-gradient\((.*)\)$/.exec(background);
  if (!m) return [paint(background)];
  return args(m[1])
    .filter((s) => !/^to\s|deg$/.test(s))
    .map((s) => paint(s.replace(/\s+[\d.]+%$/, '')));
}

const lay = (under: Rgb, p: Paint): Rgb => over(under, p.rgb, p.a);

/** The worst ground any key stands on: the panel at its thinnest over the city's brightest pixel. */
const PANEL = over(BRIGHTEST, GROUND.rgb, GROUND.textMinAlpha);

/**
 * The worst contrast of a key's words on its own face, at every fill end,
 * the whole key laid over the panel at its opacity. `windowBg` stacks a sum's
 * window over the face.
 */
function worstOnFace(d: Record<string, string>, ink: Paint, windowBg?: Paint): { ratio: number; at: string } {
  const opacity = d.opacity === undefined ? 1 : Number(d.opacity);
  let worst = { ratio: Infinity, at: '' };
  for (const fill of grounds(d.background)) {
    let face = lay(PANEL, fill);
    if (windowBg) face = lay(face, windowBg);
    const text = lay(face, ink);
    const r = contrast(lay(PANEL, { rgb: text, a: opacity }), lay(PANEL, { rgb: face, a: opacity }));
    if (r < worst.ratio) worst = { ratio: r, at: `fill ${fill.rgb.join(',')}@${fill.a}, opacity ${opacity}` };
  }
  return worst;
}

const KEY = '.os-key[data-weight]';
const W = (w: string): string => `.os-key[data-weight='${w}']`;
const DIMMED = '.os-key[data-weight]:disabled';
const GRANT_DIMMED = ".os-key[data-weight='grant']:is(:disabled, [aria-disabled='true'], [aria-busy='true'])";

test("each key's words hold 4.5:1 on its own face, every fill end, over the thinnest panel", () => {
  for (const w of ['look', 'decide', 'spend', 'grant']) {
    const d = cascade(KEY, W(w));
    assert.ok(d.color, `${w} sets no colour`);
    const { ratio, at } = worstOnFace(d, paint(d.color));
    assert.ok(ratio >= 4.5, `${w}: ${d.color} is ${ratio.toFixed(2)}:1 at ${at}`);
  }
});

test("spend's sum holds 4.5:1 in its window over both ends of the spend fill", () => {
  const sum = decls('.os-sum');
  assert.ok(sum.color && sum.background, '.os-sum sets its ink and its window');
  const d = cascade(KEY, W('spend'));
  assert.ok(grounds(d.background).length >= 2, 'spend has a gradient with two ends');
  const { ratio, at } = worstOnFace(d, paint(sum.color), paint(sum.background));
  assert.ok(ratio >= 4.5, `the sum ${sum.color} is ${ratio.toFixed(2)}:1 at ${at}`);
});

test('a dimmed grant still reads at 4.5:1, its opacity laid over the panel', () => {
  const d = cascade(KEY, W('grant'), DIMMED, GRANT_DIMMED);
  assert.ok(Object.keys(decls(DIMMED)).length, 'control.css dims disabled keys');
  const { ratio, at } = worstOnFace(d, paint(d.color));
  assert.ok(ratio >= 4.5, `the dimmed grant: ${d.color} is ${ratio.toFixed(2)}:1 at ${at}`);
});

test('the contrast reader resolves what control.css writes', () => {
  assert.deepEqual(paint('var(--os-ground)'), { rgb: hex(COLOUR.ground), a: 1 });
  assert.deepEqual(paint('rgba(var(--os-amber-rgb), 0.24)'), { rgb: hex(COLOUR.amber), a: 0.24 });
  assert.deepEqual(paint('color-mix(in srgb, var(--os-red), black 12%)').rgb, hex(COLOUR.red).map((c) => Math.round(c * 0.88)));
  assert.deepEqual(paint('color-mix(in srgb, var(--os-red) 40%, var(--os-ground))').rgb, [0, 1, 2].map((i) => Math.round(hex(COLOUR.red)[i] * 0.4 + hex(COLOUR.ground)[i] * 0.6)));
  assert.equal(grounds('linear-gradient(to bottom, white, var(--os-red) 55%, black)').length, 3);
  // The base rule is found, and @media rules (forced colours) do not leak into it.
  assert.equal(decls(KEY).border, '0');
});
