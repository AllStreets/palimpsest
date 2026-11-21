// The running head holds 4.5:1 over the brightest city pixel: a quiet dark backing behind the nav alone (audit 2026-11-17).
// Since the screens redesign (Task 11) the head is drawn by os/topbar.css in the os tokens, loaded app-wide after screens.css.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { contrast, hex, luminance, over, type Rgb } from '../app/src/ui/contrast.js';

const raw = (name: string): string => readFileSync(new URL(`../app/src/${name}`, import.meta.url), 'utf8');
const css = (name: string): string => raw(`ui/${name}`).replace(/\/\*[\s\S]*?\*\//g, '');
const screens = css('screens.css');
const style = css('style.css');
const tokens = css('os/tokens.css');
const topbar = css('os/topbar.css');

/** The city's brightest pixel, bounded above: lit glass in the overview and close framings measured 250, 250, 249 and 255, 249, 240. */
const BRIGHTEST: Rgb = [255, 255, 255];

/** The custom properties style.css, screens.css and the os tokens set on :root. */
const VARS = new Map([...`${style}\n${screens}\n${tokens}`.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2]]));
const resolve = (v: string): Rgb => {
  const name = v.startsWith('var(') ? v.slice(4, -1).trim() : null;
  assert.ok(!name || VARS.has(name), `${v} is a colour the test can read`);
  return hex(name ? VARS.get(name)! : v);
};
/** The ground's channels, as tokens.css gives them (--os-ground-rgb). */
const GROUND_RGB = /--os-ground-rgb\s*:\s*(\d+),\s*(\d+),\s*(\d+)\s*;/.exec(tokens)!.slice(1).map(Number);

/** Every top-level rule of the head's stylesheet as [selector, body]; @media blocks (forced colours, reduced motion) aside. */
const rules = [...topbar.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]] as const);

function backing(): { colour: Rgb; alpha: number; fullTo: number; top: number } {
  const rule = rules.find(([sel]) => sel === '.runhead::before');
  assert.ok(rule, 'the running head has a backing (.runhead::before) in os/topbar.css');
  const body = rule[1];
  assert.doesNotMatch(body, /border-radius|box-shadow|border\s*:|filter/, 'a gradient only: no card, no glow');
  const stops = [...body.matchAll(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)\s+(\d+)px/g)].map((m) => ({
    colour: [Number(m[1]), Number(m[2]), Number(m[3])] as Rgb,
    alpha: Number(m[4]),
    at: Number(m[5]),
  }));
  assert.ok(stops.length >= 2, 'the backing is a gradient of px stops');
  const alpha = stops[0].alpha;
  assert.equal(stops[1].alpha, alpha, 'the backing holds one strength over the words');
  const top = Number(/top:\s*(-?\d+)px/.exec(body)?.[1]);
  return { colour: stops[0].colour, alpha, fullTo: stops[1].at, top };
}

test('the contrast function reads WCAG ratios', () => {
  assert.equal(contrast([0, 0, 0], [255, 255, 255]).toFixed(2), '21.00');
  assert.equal(contrast([255, 255, 255], [255, 255, 255]), 1);
  assert.equal(luminance(hex('#767676')).toFixed(3), '0.181');
  assert.equal(contrast(hex('#767676'), [255, 255, 255]).toFixed(2), '4.54');
  assert.deepEqual(over([255, 255, 255], [0, 0, 0], 0.5), [128, 128, 128]);
});

test('the backing is the screens\' own ground', () => {
  assert.deepEqual([...backing().colour], GROUND_RGB);
});

test('every word of the running head holds 4.5:1 over the brightest city pixel behind its backing, idle, hovered and current', () => {
  const b = backing();
  const ground = over(BRIGHTEST, b.colour, b.alpha);
  const colours = rules.filter(([sel]) => /\.runhead/.test(sel) && !/::before|::after/.test(sel)).flatMap(([sel, body]) =>
    [...body.matchAll(/(?:^|[\s;])color\s*:\s*([^;]+);/g)].map((m) => [sel, m[1].trim()] as const),
  );
  assert.ok(colours.length >= 5, 'the head colours are read');
  assert.ok(colours.some(([sel]) => /aria-current/.test(sel)), 'the current place is measured');
  assert.ok(colours.some(([sel]) => /runhead-find/.test(sel)), 'Find and its shortcut are measured');
  for (const [sel, c] of colours) {
    const ratio = contrast(resolve(c), ground);
    assert.ok(ratio >= 4.5, `${sel} (${c}) reads ${ratio.toFixed(2)}:1 over lit glass`);
  }
});

test('a fill under the head\'s words never thins them: any background behind text is the ground or nothing', () => {
  for (const [sel, body] of rules) {
    if (!/\.runhead/.test(sel) || /::before|::after|::-/.test(sel)) continue;
    for (const m of body.matchAll(/(?:^|[\s;])background(?:-color)?\s*:\s*([^;]+);/g)) {
      const v = m[1].trim();
      // Corner ticks are gradients of thin strokes at the edges, not a fill under the words.
      if (/no-repeat/.test(v) || v === 'none' || v === 'transparent') continue;
      assert.match(v, /^rgba\(var\(--os-ground-rgb\),\s*[\d.]+\)$/, `${sel} lays ${v} under its words`);
    }
  }
});

test('the backing covers the head from the window top to below its words and tape, and fades out', () => {
  const b = backing();
  // The head stands 22 px down; its places are 17 px words in a 27 px line, the tape 8 px below: about 60 px at the foot.
  assert.equal(22 + b.top, 0, 'the backing starts at the window top');
  assert.ok(b.fullTo >= 62, `the backing is at full strength to ${b.fullTo} px, below the words and the tape`);
  const rule = rules.find(([sel]) => sel === '.runhead::before')![1];
  assert.match(rule, /rgba\(\d+,\s*\d+,\s*\d+,\s*0\)/, 'the backing fades to nothing');
  assert.match(rule, /mask-image:\s*linear-gradient\(to right/, 'and fades out to the right of the last word');
  assert.match(rule, /pointer-events:\s*none/);
});

test('hovering a head link never draws it in another colour, so a pointer resting on City does not light it', () => {
  const hovers = rules.filter(([sel]) => /\.runhead-link[^,]*:hover/.test(sel));
  assert.ok(hovers.length > 0, 'hover is drawn (as faint ticks)');
  for (const [sel, body] of hovers) assert.doesNotMatch(body, /(^|[\s;])color\s*:/, `${sel} sets a colour`);
  assert.ok(!rules.some(([sel]) => /data-route=.*\.runhead-link/.test(sel)), 'no rule lights a head link by route alone');
});

test('the current place is held by more than its colour: corner ticks in amber', () => {
  const cur = rules.find(([sel]) => sel === ".runhead-link[aria-current='page']");
  assert.ok(cur, 'a rule for the current place');
  assert.match(cur[1], /--tick\s*:\s*var\(--os-amber\)/);
});

test('the head lives in os/topbar.css alone, loaded app-wide after screens.css', () => {
  assert.doesNotMatch(screens, /\.runhead/, 'screens.css keeps no running head rules');
  assert.match(css('os/index.css'), /@import '\.\/topbar\.css';/);
  const main = raw('main.ts');
  const [s, o] = [main.indexOf("import './ui/screens.css';"), main.indexOf("import './ui/os/index.css';")];
  assert.ok(s >= 0 && o > s, 'main.ts imports os/index.css after screens.css');
});

test('Find is a look key: its focus ring is the os ring, and the head draws nothing on its ::after', () => {
  const ts = raw('ui/runhead.ts');
  assert.match(ts, /weighKey\(findBtn, 'look'\)/);
  assert.ok(!rules.some(([sel]) => /runhead-(find|link|stopped)[^,]*::after/.test(sel)), 'the keys\' ::after is the focus ring\'s');
});

test("Find's word holds 4.5:1 under its hover sheen (control.css), on the backing over the brightest city", () => {
  const control = css('os/control.css');
  const look = /\.os-key\[data-weight='look'\]\s*\{([^{}]*)\}/.exec(control);
  assert.ok(look, "control.css has the look key's rule");
  const sheen = /--os-sheen\s*:\s*rgba\(var\((--os-[\w-]+)-rgb\),\s*([\d.]+)\)/.exec(look[1]);
  assert.ok(sheen, 'the look sheen is a token at an alpha');
  const sheenRgb = /--os-ice-rgb\s*:\s*(\d+),\s*(\d+),\s*(\d+)\s*;/.exec(tokens)!.slice(1).map(Number) as unknown as Rgb;
  assert.equal(sheen[1], '--os-ice', 'the look sheen is ice');
  const b = backing();
  const face = over(over(BRIGHTEST, b.colour, b.alpha), sheenRgb, Number(sheen[2]));
  const find = rules.find(([sel]) => sel === ".runhead-find.os-key[data-weight='look']");
  assert.ok(find, "topbar.css sets Find's word");
  const ink = /(?:^|[\s;])color\s*:\s*([^;]+);/.exec(find[1])![1].trim();
  const ratio = contrast(resolve(ink), face);
  assert.ok(ratio >= 4.5, `Find (${ink}) reads ${ratio.toFixed(2)}:1 under its hover sheen`);
});
