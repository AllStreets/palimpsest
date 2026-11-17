/**
 * The perf tool's own settings (Phase 5 Task 0): the port it binds, so the
 * city track's perf and the screens track's never collide and neither ever
 * answers on the real engine's 4770, the tiers it measures, and the window
 * it measures at.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cityStands, openTodaysBrief, PERF_PORT_DEFAULT, PERF_VIEWPORT, perfPort, perfTiers, sameLight } from '../tools/perf.js';

test('perf.ts listens on PERF_PORT', () => {
  assert.equal(PERF_PORT_DEFAULT, 4791);
  assert.equal(perfPort(undefined), 4791);
  assert.equal(perfPort(''), 4791);
  assert.equal(perfPort('4794'), 4794);
  assert.equal(perfPort(' 4795 '), 4795);
  assert.throws(() => perfPort('4770'), /4770/);
  assert.throws(() => perfPort('4771'), /4771/);
  assert.throws(() => perfPort('abc'), /PERF_PORT/);
  assert.throws(() => perfPort('80'), /PERF_PORT/);
  assert.throws(() => perfPort('4791.5'), /PERF_PORT/);
});

test('PERF_TIERS names high, medium or both, high alone by default', () => {
  assert.deepEqual(perfTiers(undefined), ['high']);
  assert.deepEqual(perfTiers(''), ['high']);
  assert.deepEqual(perfTiers('high,medium'), ['high', 'medium']);
  assert.deepEqual(perfTiers(' medium '), ['medium']);
  assert.deepEqual(perfTiers('medium,high,medium'), ['high', 'medium']);
  assert.throws(() => perfTiers('low'), /PERF_TIERS/);
});

test('the perf viewport is the main display\'s visible frame at DPR 2', () => {
  assert.deepEqual(PERF_VIEWPORT, { width: 1512, height: 890, dpr: 2 });
});

// The brightness debug (Phase 5): every high still since Task 0 was shot on the engine's first page, which the
// day's first open turns to the brief; perf hid the sheet but not its scrim, so the city was shot through it.
test('a still is shot only with the city standing: no route over it and no scrim open', () => {
  assert.equal(cityStands({ hash: '', openScrims: 0 }), null);
  assert.equal(cityStands({ hash: '#/', openScrims: 0 }), null);
  assert.match(cityStands({ hash: '#/brief', openScrims: 1 }) ?? '', /#\/brief/);
  assert.match(cityStands({ hash: '#/brief', openScrims: 0 }) ?? '', /#\/brief/);
  assert.match(cityStands({ hash: '', openScrims: 1 }) ?? '', /scrim/);
});

test('perf opens today\'s brief on its engine before its first page, as the UI test does', async () => {
  const asked: Array<{ url: string; method: string; header: string | null }> = [];
  const fake = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    asked.push({ url: String(url), method: init?.method ?? 'GET', header: new Headers(init?.headers).get('x-palimpsest') });
    return new Response('{}', { status: 200 });
  };
  await openTodaysBrief(4791, fake);
  assert.deepEqual(asked, [{ url: 'http://127.0.0.1:4791/api/brief/open', method: 'POST', header: '1' }]);
  const refused = async (): Promise<Response> => new Response('no', { status: 500 });
  await assert.rejects(openTodaysBrief(4791, refused), /brief/);
});

test('the first page and a second are the same light within 3%', () => {
  assert.equal(sameLight(115.4, 115.39), true);
  assert.equal(sameLight(100, 103), true);
  assert.equal(sameLight(100, 96.9), false);
  // Task 14's pair: the high home through the brief's scrim against the same view without it.
  assert.equal(sameLight(62.14, 115.4), false);
});

test('every named view holds 58 fps on high and on medium: perf names each view under the floor, and a view never measured is under it', async () => {
  const P = (await import('../tools/perf.js')) as unknown as Record<string, unknown>;
  const slowViews = P.slowViews as (rows: Record<string, { fps: number }>, floor?: number) => string[];
  assert.equal(P.FPS_FLOOR, 58);
  assert.deepEqual(slowViews({ home: { fps: 59.9 }, hero: { fps: 58 } }), []);
  assert.deepEqual(slowViews({ home: { fps: 59.9 }, ride: { fps: 30 }, 'follow-held': { fps: 0 } }), ['follow-held 0.0', 'ride 30.0']);
  const medianRate = P.medianRate as (ms: number[]) => number;
  assert.ok(Math.abs(medianRate([16.7, 16.7, 33.4]) - 1000 / 16.7) < 1e-9);
});

test('a view asked for and not measured is named, never a silent gap', async () => {
  const P = (await import('../tools/perf.js')) as unknown as Record<string, unknown>;
  const missingViews = P.missingViews as (expected: string[], rows: Record<string, unknown>) => string[];
  assert.deepEqual(missingViews(['home', 'sun-low', 'tour-stop', 'first-frame'], { home: {}, 'tour-stop': {} }), ['sun-low']);
});
