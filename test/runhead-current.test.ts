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

/** The head's own stylesheet (screens redesign Task 11), comments stripped; screens.css no longer draws the head. */
const topbar = (): string => readFileSync(new URL('../app/src/ui/os/topbar.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('no stylesheet rule lifts a head link by route alone, so only the current one reads lit', () => {
  const css = topbar();
  assert.match(css, /\.runhead-link[^{}]*\{/, 'topbar.css draws the head links');
  assert.doesNotMatch(css, /data-route=[^{}]*\.runhead-link[^{}]*\{/);
});

test('hovering a head link, Find or Stopped never draws it in another colour, so a pointer resting on City does not light it', () => {
  const matches = [...topbar().matchAll(/([^{}]*\.runhead-(?:link|find|stopped)[^{}]*:hover[^{}]*)\{([^}]*)\}/g)];
  assert.ok(matches.length > 0, 'topbar.css draws a hover');
  for (const m of matches) {
    assert.doesNotMatch(m[2], /(^|[\s;])color\s*:/, `${m[1].trim()} sets a colour`);
  }
});
