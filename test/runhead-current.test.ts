// The running head lights exactly one place: the section the current route lives under.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { currentSection, SCREENS, type Route } from '../app/src/router.js';

/** Every route and the head item it must light. */
const EXPECT: Array<[Route, Route]> = [
  ...SCREENS.map(({ route }): [Route, Route] => [route, route]),
  ['inspection', 'jobs'],
  ['audit', 'repos'],
  ['job', 'jobs'],
  ['run', 'jobs'],
  ['firm', 'firms'],
  ['agent', 'firms'],
  ['repo', 'repos'],
  ['net', 'school'],
  ['voyage', 'school'],
  ['graduate', 'school'],
];

test('each route lights exactly one head item, the right one', () => {
  for (const [route, want] of EXPECT) {
    const lit = SCREENS.filter((s) => s.route === currentSection(route)).map((s) => s.route);
    assert.deepEqual(lit, [want], `route ${route}`);
  }
});

test('City is current only on the city route', () => {
  for (const [route] of EXPECT) assert.equal(currentSection(route) === 'city', route === 'city', route);
});

test('no stylesheet rule lifts a head link by route alone, so only the current one reads lit', () => {
  const css = readFileSync(new URL('../app/src/ui/screens.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /data-route='city'\]\s+\.runhead-link\s*\{/);
});

test('hovering a head link never draws it in the current place\'s colour, so a pointer resting on City does not light it', () => {
  const css = readFileSync(new URL('../app/src/ui/screens.css', import.meta.url), 'utf8');
  for (const m of css.matchAll(/([^{}]*\.runhead-link[^{}]*:hover[^{}]*)\{([^}]*)\}/g)) {
    assert.doesNotMatch(m[2], /(^|[\s;])color\s*:/, `${m[1].trim()} sets a colour`);
  }
});
