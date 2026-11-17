// The running head holds 4.5:1 over the brightest city pixel: a quiet dark backing behind the nav alone (audit 2026-11-17).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { contrast, hex, luminance, over, type Rgb } from '../app/src/ui/contrast.js';

const css = (name: string): string => readFileSync(new URL(`../app/src/ui/${name}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const screens = css('screens.css');
const style = css('style.css');

/** The city's brightest pixel, bounded above: lit glass in the overview and close framings measured 250, 250, 249 and 255, 249, 240. */
const BRIGHTEST: Rgb = [255, 255, 255];

/** The custom properties style.css and screens.css set on :root. */
const VARS = new Map([...`${style}\n${screens}`.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2]]));
const resolve = (v: string): Rgb => hex(v.startsWith('var(') ? VARS.get(v.slice(4, -1).trim())! : v);

/** Every rule of the stylesheet as [selector, body]. */
const rules = [...screens.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]] as const);

function backing(): { colour: Rgb; alpha: number; fullTo: number; top: number } {
  const rule = rules.find(([sel]) => sel === '.runhead::before');
  assert.ok(rule, 'the running head has a backing (.runhead::before)');
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

test('every word of the running head holds 4.5:1 over the brightest city pixel behind its backing', () => {
  const b = backing();
  const ground = over(BRIGHTEST, b.colour, b.alpha);
  const colours = rules.filter(([sel]) => /\.runhead/.test(sel) && !/::before|::after/.test(sel)).flatMap(([sel, body]) =>
    [...body.matchAll(/(?:^|[\s;])color\s*:\s*([^;]+);/g)].map((m) => [sel, m[1].trim()] as const),
  );
  assert.ok(colours.length >= 4, 'the head colours are read');
  for (const [sel, c] of colours) {
    const ratio = contrast(resolve(c), ground);
    assert.ok(ratio >= 4.5, `${sel} (${c}) reads ${ratio.toFixed(2)}:1 over lit glass`);
  }
});

test('the backing covers the head from the window top to below its words, and fades out', () => {
  const b = backing();
  // The head stands 22 px down; its links are 13.5 px words with 4 px above and 6 px below: about 50 px at the foot.
  assert.equal(22 + b.top, 0, 'the backing starts at the window top');
  assert.ok(b.fullTo >= 56, `the backing is at full strength to ${b.fullTo} px, below the words`);
  const rule = rules.find(([sel]) => sel === '.runhead::before')![1];
  assert.match(rule, /rgba\(\d+,\s*\d+,\s*\d+,\s*0\)/, 'the backing fades to nothing');
  assert.match(rule, /mask-image:\s*linear-gradient\(to right/, 'and fades out to the right of the last word');
  assert.match(rule, /pointer-events:\s*none/);
});
